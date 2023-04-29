// TODO Organize and split into multiple files

import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  ActivityType,
  PermissionsBitField,
  Guild,
  GuildMember,
} from "discord.js";
import { config } from "dotenv";
import { ProviderLink, ServerSettings } from "./odm";
import mongoose from "mongoose";
import Express from "express";
import { ObjectId } from "mongodb";

config();

const verifyTwitterAuthorization = async (
  accessToken: string,
  twitterId: string
) => {
  const response = await fetch(`https://api.twitter.com/2/users/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const verified = response.status === 200;

  if (verified) {
    return true;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  const abort = async () => {
    await session.abortTransaction();
    await session.endSession();
  };

  try {
    await ProviderLink.updateOne(
      {
        provider: "twitter",
        providerId: twitterId,
      },
      {
        $set: {
          revokedAt: new Date(),
        },
      },
      { session }
    );

    const oldAccount = await mongoose.connection.db
      .collection("accounts")
      .findOne(
        {
          providerAccountId: twitterId,
          provider: "twitter",
        },
        { session }
      );

    if (!oldAccount) {
      await session.commitTransaction();
      await session.endSession();
      return false;
    }

    await mongoose.connection.db.collection("users").deleteOne(
      {
        _id: oldAccount.userId,
      },
      { session }
    );

    await mongoose.connection.db.collection("accounts").deleteOne(
      {
        _id: oldAccount._id,
      },
      { session }
    );

    await session.commitTransaction();
    await session.endSession();
  } catch (error) {
    console.error(error);
    await abort();
  }

  return false;
  // remove the account
};

const getUserDataFromDiscordId = async (discordId: string) => {
  console.log("Getting user data from discord id", discordId);

  try {
    if (discordId.startsWith("<@") && discordId.endsWith(">")) {
      discordId = discordId.trim().slice(2, -1);
    }

    // get all the links for the user
    const using = ["twitter", "google", "ethereum"];

    const links = await ProviderLink.find({
      discordId,
      provider: { $in: using },
    });

    return Object.fromEntries(
      links.map((link) => [link.provider, link.providerId])
    );
  } catch (error) {
    console.error(error);
    return null;
  }
};

const { TOKEN, CLIENT_ID, MONGODB_URI, WEBHOOK_PORT } = process.env;

// set up the express server
const app = Express();
app.use(Express.json());

app.post("/discord", async (req, res) => {
  const { body } = req;
  const id = body.id;

  if (!id) {
    console.log("No id in body");
    res.sendStatus(400);
    res.end();
    return;
  }

  await updateUserRoles(id);

  res.sendStatus(200);
  res.end();
});

app.post("/checkAuth", async (req, res) => {
  try {
    const docs = await mongoose.connection.db
      .collection("providerlinks")
      .aggregate([
        {
          $match: {
            provider: "twitter",
          },
        },
        {
          $lookup: {
            from: "accounts",
            localField: "providerId",
            foreignField: "providerAccountId",
            as: "account",
          },
        },
        // project so that we just get the discord id the twitter id and the access token
        {
          $project: {
            discordId: 1,
            providerId: 1,
            accessToken: { $arrayElemAt: ["$account.access_token", 0] },
            accountId: { $arrayElemAt: ["$account._id", 0] },
            userId: { $arrayElemAt: ["$account.userId", 0] },
          },
        },
      ])
      .toArray();

    const verified = await Promise.all(
      docs.map(async (doc) => {
        const verified = await verifyTwitterAuthorization(
          doc.accessToken,
          doc.providerId
        );

        return {
          discordId: doc.discordId,
          verified,
        };
      })
    );

    console.log(verified);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
    res.end();
    return;
  }

  res.sendStatus(200);
  res.end();
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`Listening on port ${WEBHOOK_PORT}`);
});

const commands = [
  // return the users address and twitter id
  {
    name: "info",
    description: "Returns the users address and twitter id",
    options: [
      {
        name: "discord_id",
        description: "The discord id of the user",
        type: 3,
        required: true,
      },
    ],
  },
  // sets the verified role for the server
  {
    name: "setrole",
    description: "Sets the verified role for the server",
    options: [
      {
        name: "role",
        description: "The role to set",
        type: 8,
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    await mongoose.connect(MONGODB_URI, {});
    mongoose.set("bufferTimeoutMS", 2500);

    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }

  // set up watches on insertions for the two collections (does not work with serverless)
  // const providerLinkChangeStream = ProviderLink.watch();

  // providerLinkChangeStream.on("change", (change) => {
  //   console.log(change);
  // });
})();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const isUserVerified = async (discordId: string) => {
  const userData = await getUserDataFromDiscordId(discordId);
  if (!userData) {
    return false;
  }
  return ["twitter", "google", "ethereum"].every(
    (provider) => provider in userData
  );
};

const updateUserRoleForGuild = async (
  discordId: string,
  guild: Guild,
  verified: boolean
) => {
  // check if the user is in the server
  try {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(discordId);
      if (!member) {
        console.log("User not found in guild", guild.id);
        return;
      }
    } catch (error) {
      console.log("User not found in guild", guild.id);
      return;
    }

    // get the server settings
    const serverSettings = await ServerSettings.findOne({
      guildId: guild.id,
    });
    if (!serverSettings) {
      console.log("No server settings found for guild", guild.id);
      return;
    }

    const verifiedRole = serverSettings.roleId;

    // grant the user the verified role
    if (verified) {
      await member.roles.add(verifiedRole);
    } else {
      await member.roles.remove(verifiedRole);
    }
  } catch (error) {
    console.error(error);
  }
};

const updateUserRoles = async (discordId: string) => {
  // check each server the bot is in
  const verificationStatus = await isUserVerified(discordId);
  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    await updateUserRoleForGuild(discordId, guild, verificationStatus);
  }
};

client.on("guildMemberAdd", async (member) => {
  const discordId = member.id;
  await updateUserRoles(discordId);
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);

  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "www.social-link.xyz",
        type: ActivityType.Playing,
        url: "https://www.social-link.xyz",
      },
    ],
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "info") {
    const discordId = interaction.options.getString("discord_id");
    const userData = await getUserDataFromDiscordId(discordId);
    if (!userData) {
      await interaction.reply("No user found");
      return;
    }
    // prettier-ignore
    await interaction.reply(
`Discord ID: ${discordId}
Address: ${userData.ethereum}
Twitter: ${userData.twitter}
Google: ${userData.google}`
    );
  } else if (interaction.commandName === "setrole") {
    // check if the user has the manage roles permission
    const hasPermission = (
      interaction.member.permissions as Readonly<PermissionsBitField>
    ).has(PermissionsBitField.Flags.ManageRoles);
    if (!hasPermission) {
      await interaction.reply("You do not have permission to do this");
      return;
    }
    const guildId = interaction.guildId;
    const roleId = interaction.options.getRole("role").id;
    await ServerSettings.findOneAndUpdate(
      { guildId },
      { roleId },
      { upsert: true }
    );
    await interaction.reply("Verified role set");
  }
});

client.login(TOKEN);
