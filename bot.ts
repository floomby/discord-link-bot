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
import mongoose, { set } from "mongoose";
import Express from "express";
import fetch from "node-fetch";

config();

const getTwitterInfo = async (
  discordId: string
): Promise<{
  username: string;
  avatar: string;
  followers: string[];
} | null> => {
  try {
    if (discordId.startsWith("<@") && discordId.endsWith(">")) {
      discordId = discordId.trim().slice(2, -1);
    }
    const session = await mongoose.startSession();
    session.startTransaction();
    const abort = async () => {
      await session.abortTransaction();
      await session.endSession();
    };

    const link = await ProviderLink.findOne(
      {
        discordId,
        provider: "twitter",
        revokedAt: null,
      },
      undefined,
      { session }
    );

    if (!link) {
      console.log("No link found");
      await abort();
      return null;
    }

    const account = await mongoose.connection.db.collection("accounts").findOne(
      {
        providerAccountId: link.providerId,
      },
      { session }
    );

    if (!account) {
      console.log("No account found");
      await abort();
      return null;
    }

    // const me = await fetch(`https://api.twitter.com/2/users/me`, {
    //   headers: {
    //     Authorization: `Bearer ${account.accessToken}`,
    //   },
    // });
    // const meJson = await me.json();
    // console.log(meJson);

    // get followers https://api.twitter.com/2/users/:id/following
    const followers = await fetch(
      `https://api.twitter.com/2/users/${link.providerId}/following`,
      {
        headers: {
          // Authorization: `Bearer ${account.accessToken}`,
          Authorization: `Bearer AAAAAAAAAAAAAAAAAAAAANDdmwEAAAAAJy7Ms6s4r2K8E8AM95v6cShigAc%3DEZ5gwHVmI0uDcECv0w2mmhUAryYBlZif7e2TjustNXKNBQXPjY`,
        },
      }
    );
    const followersJson = await followers.json();
    console.log(followersJson);
  } catch (error) {
    console.error(error);
    return null;
  }

  return null;
};

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
};

const verifyGithubAuthorization = async (
  accessToken: string,
  githubId: string
) => {
  const response = await fetch(`https://api.github.com`, {
    headers: {
      Authorization: `token ${accessToken}`,
    },
  });

  const verified = response.headers.get("x-oauth-scopes")?.includes("user");

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
        provider: "github",
        providerId: githubId,
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
          providerAccountId: githubId,
          provider: "github",
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
};

const supportedProviders = ["twitter", "google", "ethereum", "github"];

const getUserDataFromDiscordId = async (discordId: string) => {
  console.log("Getting user data from discord id", discordId);

  try {
    if (discordId.startsWith("<@") && discordId.endsWith(">")) {
      discordId = discordId.trim().slice(2, -1);
    }

    const links = await ProviderLink.find({
      discordId,
      provider: { $in: supportedProviders },
      revokedAt: null,
    });

    return Object.fromEntries(
      links.map((link) => [link.provider, link.providerId])
    );
  } catch (error) {
    console.error(error);
    return null;
  }
};

const { TOKEN, CLIENT_ID, MONGODB_URI, WEBHOOK_PORT, DEVELOPER_ID } =
  process.env;

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

const checkAuth = async () => {
  try {
    const docs = await mongoose.connection.db
      .collection("providerlinks")
      .aggregate([
        {
          $match: {
            provider: { $in: ["twitter", "github"] },
            revokedAt: null,
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
            provider: 1,
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
        const verified = await (doc.provider === "twitter"
          ? verifyTwitterAuthorization(doc.accessToken, doc.providerId)
          : verifyGithubAuthorization(doc.accessToken, doc.providerId));

        return {
          discordId: doc.discordId,
          verified,
        };
      })
    );
  } catch (error) {
    console.error(error);
    return false;
  }

  return true;
};

app.post("/checkAuth", async (req, res) => {
  const success = await checkAuth();
  if (!success) {
    res.sendStatus(500);
    res.end();
    return;
  }
  res.sendStatus(200);
  res.end();
});

setInterval(checkAuth, 1000 * 20 * 60);

app.listen(WEBHOOK_PORT, () => {
  console.log(`Listening on port ${WEBHOOK_PORT}`);
});

const commands = [
  // return the users address and twitter id
  {
    name: "info",
    description: "Returns the users details",
    options: [
      {
        name: "discord_id",
        description: "The discord id of the user",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "twitterinfo",
    description: "Returns the users twitter sso image and followers",
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
  {
    name: "displayrole",
    description: "Displays the verified role for the server",
    options: [],
  },
  {
    name: "sync",
    description: "Re-syncs every user on the server",
    options: [],
  },
  {
    name: "setproviders",
    description:
      "Sets the verification providers for the server in the form of <provider>,<provider>,...",
    options: [
      {
        name: "providers",
        description: "The providers to set",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "listproviders",
    description: "Lists the verification providers for the server",
    options: [],
  },
  {
    name: "supportedproviders",
    description: "Lists the supported verification providers",
    options: [],
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
    return {};
  }
  return userData;
};

const updateUserRoleForGuild = async (
  discordId: string,
  guild: Guild,
  verified: { [key: string]: string }
) => {
  // check if the user is in the server
  try {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(discordId);
      if (!member) {
        console.log(`User ${discordId} not found in guild`, guild.id);
        return;
      }
    } catch (error) {
      console.log(`User ${discordId} not found in guild`, guild.id);
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
    console.log(verified);
    if (serverSettings.providers.every((p) => verified[p])) {
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

// set presence when the bot joins a server
client.on("guildCreate", () => {
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

setInterval(async () => {
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
}, 1000 * 60 * 60 * 24);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "info") {
    // check if the user id is the developer id
    const isDeveloper = interaction.user.id === DEVELOPER_ID;
    if (!isDeveloper) {
      await interaction.reply("You do not have permission to do this");
      return;
    }

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
Google: ${userData.google}
Github: ${userData.github}`
    );
  } else if (interaction.commandName === "twitterinfo") {
    // check if the user id is the developer id
    const isDeveloper = interaction.user.id === DEVELOPER_ID;
    if (!isDeveloper) {
      await interaction.reply("You do not have permission to do this");
      return;
    }

    const discordId = interaction.options.getString("discord_id");

    const twitterInfo = await getTwitterInfo(discordId);

    await interaction.reply(
      "getting twitter info for " + discordId + " " + twitterInfo
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

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.log("Guild not found", guildId);
      return;
    }

    const members = await guild.members.fetch();
    for (const member of members.values()) {
      await updateUserRoles(member.id);
    }
  } else if (interaction.commandName === "sync") {
    const hasPermission = (
      interaction.member.permissions as Readonly<PermissionsBitField>
    ).has(PermissionsBitField.Flags.ManageRoles);
    if (!hasPermission) {
      await interaction.reply("You do not have permission to do this");
      return;
    }
    const guildId = interaction.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      await interaction.reply("No guild found");
      return;
    }
    await interaction.reply("Resyncing users");
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      await updateUserRoles(member.id);
    }
  } else if (interaction.commandName === "displayrole") {
    const guildId = interaction.guildId;
    const serverSettings = await ServerSettings.findOne({ guildId });
    if (!serverSettings) {
      await interaction.reply("No role set");
      return;
    }
    const roleId = serverSettings.roleId;
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.reply("No role set");
      return;
    }
    await interaction.reply(`Role set to \`${role.name}\``);
  } else if (interaction.commandName === "setproviders") {
    const hasPermission = (
      interaction.member.permissions as Readonly<PermissionsBitField>
    ).has(PermissionsBitField.Flags.ManageRoles);
    if (!hasPermission) {
      await interaction.reply("You do not have permission to do this");
      return;
    }
    const guildId = interaction.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      await interaction.reply("No guild found");
      return;
    }

    const providers = interaction.options.getString("providers");
    const providersArray = providers
      .split(",")
      .map((provider) => provider.trim());

    if (
      !providersArray.every((provider) => supportedProviders.includes(provider))
    ) {
      await interaction.reply("Invalid provider options");
      return;
    }

    await ServerSettings.findOneAndUpdate(
      { guildId },
      { providers: providersArray },
      { upsert: true }
    );
    await interaction.reply(
      "Providers set to " + providersArray.map((p) => `\`${p}\``).join(" ")
    );
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      await updateUserRoles(member.id);
    }
  } else if (interaction.commandName === "listproviders") {
    const guildId = interaction.guildId;
    const serverSettings = await ServerSettings.findOne({ guildId });
    if (!serverSettings) {
      await interaction.reply("No providers set");
      return;
    }
    const providers = serverSettings.providers;
    await interaction.reply(
      `Providers set to ${providers.map((p) => `\`${p}\``).join(" ")}`
    );
  } else if (interaction.commandName === "supportedproviders") {
    await interaction.reply(
      "Currently supports " +
        supportedProviders.map((p) => `\`${p}\``).join(" ")
    );
  }
});

client.login(TOKEN);
