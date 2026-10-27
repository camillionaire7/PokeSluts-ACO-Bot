require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionsBitField, 
    EmbedBuilder 
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Helper: Decode basic HTML entities commonly found in retailer webhooks
function decodeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&#233;/g, 'é')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

// 1. Command Definitions
const commands = [
    new SlashCommandBuilder()
        .setName('generate-recap')
        .setDescription('Scrub logs to generate a drop summary.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption(option =>
            option.setName('timeframe')
                .setDescription('Select how far back to scrub logs')
                .setRequired(true)
                .addChoices(
                    { name: 'Last 6 Hours', value: '6h' },
                    { name: 'Last 24 Hours', value: '24h' },
                    { name: 'Last 7 Days', value: '7d' },
                    { name: 'Last 30 Days', value: '30d' }
                )
        ),
    new SlashCommandBuilder()
        .setName('create-invite')
        .setDescription('Generates a clean server invite created by the bot')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.CreateInstantInvite)
];

client.once('ready', async () => {
    console.log(`🤖 Logged in as \${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, '1431805290868641795'), 
            { body: commands }
        );
        console.log('✅ Slash commands registered to the guild.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // --- /create-invite Command ---
    if (interaction.commandName === 'create-invite') {
        try {
            const invite = await interaction.channel.createInvite({
                maxAge: 0,
                maxUses: 0,
                unique: true,
                reason: 'Bot-generated anonymous server invite'
            });

            return await interaction.reply({
                content: `Here
