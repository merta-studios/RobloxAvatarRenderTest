import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";

export const commands = [{
  name: "render_avatar",
  description: "Rendert den aktuellen 3D-Avatar eines Roblox-Users",
  default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  dm_permission: false,
  options: [{
    name: "username",
    description: "Roblox-Username (kein Display Name)",
    type: ApplicationCommandOptionType.String,
    required: true,
    min_length: 3,
    max_length: 20,
  }],
}];
