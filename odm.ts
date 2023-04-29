import mongoose, { ObjectId, Schema, SchemaType } from "mongoose";

interface IProviderLink {
  discordId: string;
  provider: string;
  providerId: string;
  userId: ObjectId;
  linkedAt: Date;
  revokedAt?: Date;
}

const ProviderLinkSchema = new mongoose.Schema<IProviderLink>({
  discordId: { type: String, required: true },
  provider: { type: String, required: true },
  providerId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId },
  linkedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date },
});

const ProviderLink =
  (mongoose.models.ProviderLink as mongoose.Model<IProviderLink>) ||
  mongoose.model<IProviderLink>("ProviderLink", ProviderLinkSchema);

interface IServerSettings {
  guildId: string;
  roleId: string;
  providers: string[];
};

const ServerSettingsSchema = new mongoose.Schema<IServerSettings>({
  guildId: { type: String, required: true, unique: true },
  roleId: { type: String, required: true },
  providers: { type: [String], required: true, default: ["twitter", "google", "ethereum"] },
});

const ServerSettings =
  (mongoose.models.ServerSettings as mongoose.Model<IServerSettings>) ||
  mongoose.model<IServerSettings>("ServerSettings", ServerSettingsSchema);

export { ProviderLink, ServerSettings };
