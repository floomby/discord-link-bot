import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  ActivityType,
} from "discord.js";
import { config } from "dotenv";
import { ProviderLink } from "./odm";
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

    const discordUser = await ProviderLink.findOne({ providerId: discordId, provider: "discord" });
    console.log("Discord user", discordUser, discordId);
    if (!discordUser) {
      abort();
      return null;
    }
    
    // get all the other links
    const address = discordUser.address;
    const otherLinks = await ProviderLink.find({ address, provider: { $ne: "discord" } });
    
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
  const id = body.id;

  if (!body.id) {
    console.log("No id in body");
    res.sendStatus(400);
    res.end();
    return;
  }

  console.log("Discord webhook", id);
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
  }
});

client.login(TOKEN);
