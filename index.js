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

// 1. Define the Command with Timeframe Options
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
        )
];

client.once('ready', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'generate-recap') return;

    // Fetching up to 30 days of messages takes time, so we must defer the reply
    await interaction.deferReply();

    const timeframeValue = interaction.options.getString('timeframe');
    let hoursToScrub = 6;
    let displayTitle = "6-Hour";

    if (timeframeValue === '6h') { hoursToScrub = 6; displayTitle = "6-Hour"; }
    else if (timeframeValue === '24h') { hoursToScrub = 24; displayTitle = "24-Hour"; }
    else if (timeframeValue === '7d') { hoursToScrub = 24 * 7; displayTitle = "7-Day"; }
    else if (timeframeValue === '30d') { hoursToScrub = 24 * 30; displayTitle = "30-Day"; }

    const channel = interaction.channel;
    const timeLimitMs = Date.now() - (hoursToScrub * 60 * 60 * 1000);
    
    let allMessages = [];
    let lastId;

    // 2. Fetch all messages within the selected timeframe
    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        const validMessages = messages.filter(m => m.createdTimestamp >= timeLimitMs);
        allMessages.push(...validMessages.values());

        if (messages.size < 100 || validMessages.size < messages.size) {
            break;
        }
        lastId = messages.last().id;
    }

    // 3. Parse the Hayha/Polar Webhooks
    const itemData = {};
    let totalCheckouts = 0;
    let totalCancels = 0;
    let totalSpend = 0;

    for (const msg of allMessages) {
        if (msg.embeds.length === 0) continue;
        
        const embed = msg.embeds[0];
        const isSuccess = embed.title && embed.title.toLowerCase().includes('success');
        const isCancel = embed.title && (embed.title.toLowerCase().includes('decline') || embed.title.toLowerCase().includes('cancel'));
        
        if (!isSuccess && !isCancel) continue;

        let productName = "Unknown Item";
        let price = 0;
        let link = "https://bandai.com";

        embed.fields.forEach(field => {
            if (field.name.toLowerCase().includes('product') || field.name.toLowerCase().includes('item')) {
                productName = field.value.replace(/\[\vert{}\]|\(http.*?\)/g, '').trim();
            }
            if (field.name.toLowerCase().includes('price')) {
                price = parseFloat(field.value.replace(/[^0-9.]/g, '')) || 0;
            }
        });

        if (!itemData[productName]) {
            itemData[productName] = { checkouts: 0, cancels: 0, price: price, link: embed.url || link };
        }

        if (isSuccess) {
            itemData[productName].checkouts += 1;
            totalCheckouts += 1;
            totalSpend += price;
        } else if (isCancel) {
            itemData[productName].cancels += 1;
            totalCancels += 1;
        }
    }

    if (totalCheckouts === 0 && totalCancels === 0) {
        return interaction.editReply(`No checkout or cancellation logs found in the last ${displayTitle}.`);
    }

    // 4. Calculate Stick Rate & Build the Embed
    const totalAttempts = totalCheckouts + totalCancels;
    const stickRate = totalAttempts > 0 ? ((totalCheckouts / totalAttempts) * 100).toFixed(1) : 0;

    const recapEmbed = new EmbedBuilder()
        .setTitle(`🎉 ${displayTitle} Drop Recap - ACO Success`)
        .setColor(16724911)
        .setDescription(`**Overview Stats:**\n📦 **Total Checkouts:** \`${totalCheckouts}\`\n💸 **Total Spend:** \`$${totalSpend.toFixed(2)}\`\n📈 **Stick Rate:** \`${stickRate}%\`\n\n**Item Breakdown:**`)
        .setFooter({ text: 'PokeSluts ACO Bot • Auto-Scraped' })
        .setTimestamp();

    for (const [itemName, data] of Object.entries(itemData)) {
        recapEmbed.addFields({
            name: `🛒 ${itemName}`,
            value: `**Price:** \`$${data.price.toFixed(2)}\`\n**Checkouts:** \`${data.checkouts}\`\n**Cancels:** \`${data.cancels}\`\n**Link:** [Click Here](${data.link})`,
            inline: true
        });
    }

    // 5. Send the finished drop card to the channel
    await interaction.editReply({ embeds: [recapEmbed] });
});

client.login(process.env.BOT_TOKEN);
