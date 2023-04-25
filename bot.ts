import { REST, Routes, Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import { DiscordLink, TwitterLink } from "./odm";
import mongoose from "mongoose";

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

    const discordUser = await DiscordLink.findOne({ discordId });
    console.log("Discord user", discordUser, discordId);
    if (!discordUser) {
      abort();
      return null;
    }
    const address = discordUser.address;
    const twitterUser = await TwitterLink.findOne({ address });
    if (!twitterUser) {
      abort();
      return null;
    }

    // commit the transaction
    await session.commitTransaction();
    session.endSession();

    return {
      discordId,
      address,
      twitterId: twitterUser.twitterId,
    };
  } catch (error) {
    console.error(error);
    return null;
  }
};


const { TOKEN, CLIENT_ID, MONGODB_URI } = process.env;

const commands = [
  {
    name: "ping",
    description: "Replies with Pong!",
  },
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

  // set up watches on insertions for the two collections
  const discordLinkChangeStream = DiscordLink.watch();
  const twitterLinkChangeStream = TwitterLink.watch();

  discordLinkChangeStream.on("change", (change) => {
    console.log(change);
  });
  twitterLinkChangeStream.on("change", (change) => {
    console.log(change);
  });
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("Pong!");
  } else if (interaction.commandName === "info") {
    const discordId = interaction.options.getString("discord_id");
    const userData = await getUserDataFromDiscordId(discordId);
    if (!userData) {
      await interaction.reply("No user found");
      return;
    }
    await interaction.reply(
      `Address: ${userData.address}\nTwitter Id: ${userData.twitterId}`
    );
  }
});

client.login(TOKEN);
