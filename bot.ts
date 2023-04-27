import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  ActivityType,
  PermissionsBitField,
} from "discord.js";
import { config } from "dotenv";
import { ProviderLink, ServerSettings } from "./odm";
import mongoose from "mongoose";
import Express from "express";

config();

const getUserDataFromDiscordId = async (discordId: string) => {
  // start a transaction
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    const abort = () => {
      session.abortTransaction();
      session.endSession();
    };

    discordId = discordId.trim().slice(2, -1);

    const discordUser = await ProviderLink.findOne({
      providerId: discordId,
      provider: "discord",
    });
    console.log("Discord user", discordUser, discordId);
    if (!discordUser) {
      abort();
      return null;
    }

    // get all the other links
    const address = discordUser.address;
    const otherLinks = await ProviderLink.find({
      address,
      provider: { $ne: "discord" },
    });

    const twitterUser = otherLinks.find((link) => link.provider === "twitter");
    const googleUser = otherLinks.find((link) => link.provider === "google");

    // commit the transaction
    await session.commitTransaction();
    session.endSession();

    return {
      discordId,
      address,
      twitterId: twitterUser?.providerId ?? null,
      googleId: googleUser?.providerId ?? null,
    };
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
  const address = body.address;

  if (!address) {
    console.log("No address in body");
    res.sendStatus(400);
    res.end();
    return;
  }

  const links = await ProviderLink.find({ address });
  if (links.length === 0) {
    console.log("No links found");
    res.sendStatus(404);
    res.end();
    return;
  }

  const discordLinks = links.filter((link) => link.provider === "discord");
  if (discordLinks.length === 0) {
    console.log("No discord links found");
    res.sendStatus(404);
    res.end();
    return;
  }

  if (discordLinks.length > 1) {
    console.log("Warning: More than one discord link found");
  }

  const discordLink = discordLinks[0];

  const discordId = discordLink.providerId;

  // TODO Update the user roles if they have linked the accounts
  // console.log("TODO: Update user roles", discordId);
  await updateUserRoles(discordId);

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const updateUserRoles = async (discordId: string) => {
  // check each server the bot is in
  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    // get the server settings
    const serverSettings = await ServerSettings.findOne({
      guildId: guild.id,
    });
    if (!serverSettings) {
      console.log("No server settings found for guild", guild.id);
      continue;
    }

    // check if the user is in the server
    const member = await guild.members.fetch(discordId);
    if (!member) {
      console.log("User not found in guild", guild.id);
      continue;
    }

    const verifiedRole = serverSettings.roleId;

    // grant the user the verified role
    await member.roles.add(verifiedRole);
  }
};

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
    await interaction.reply(
      `Address: ${userData.address}\nTwitter Id: ${userData.twitterId}`
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
