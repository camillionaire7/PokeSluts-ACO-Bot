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

function decodeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&#233;/g, 'é')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

const commands = [
    new SlashCommandBuilder()
        .setName('generate-recap')
        .setDescription('Scrub full-logs to generate a drop summary in the current channel.')
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
    console.log(`🤖 Logged in as ${client.user.tag}!`);
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
                content: `Here is your invite link:\n${invite.url}`,
                ephemeral: true
            });
        } catch (error) {
            console.error('Failed to create invite:', error);
            return await interaction.reply({
                content: 'Failed to create invite link. Ensure the bot has the **Create Instant Invite** permission in this channel.',
                ephemeral: true
            });
        }
    }

    // --- /generate-recap Command ---
    if (interaction.commandName === 'generate-recap') {
        await interaction.deferReply();

        // Always scrapes 🦾︱full-logs regardless of which channel you run the command in
        const LOGS_CHANNEL_ID = '1548504323703705670'; 
        
        let logsChannel;
        try {
            logsChannel = await client.channels.fetch(LOGS_CHANNEL_ID);
        } catch (error) {
            return interaction.editReply("Could not access <#1548504323703705670>. Ensure the bot has 'View Channel' and 'Read Message History' permissions in 🦾︱full-logs.");
        }

        const timeframeValue = interaction.options.getString('timeframe');
        
        let hoursToScrub = 6;
        let displayTitle = "6-Hour";

        if (timeframeValue === '6h') { hoursToScrub = 6; displayTitle = "6-Hour"; }
        else if (timeframeValue === '24h') { hoursToScrub = 24; displayTitle = "24-Hour"; }
        else if (timeframeValue === '7d') { hoursToScrub = 24 * 7; displayTitle = "7-Day"; }
        else if (timeframeValue === '30d') { hoursToScrub = 24 * 30; displayTitle = "30-Day"; }

        const timeLimitMs = Date.now() - (hoursToScrub * 60 * 60 * 1000);
        
        let allMessages = [];
        let lastId;

        while (true) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;

            const messages = await logsChannel.messages.fetch(options);
            if (messages.size === 0) break;

            const validMessages = messages.filter(m => m.createdTimestamp >= timeLimitMs);
            allMessages.push(...validMessages.values());

            if (messages.size < 100 || validMessages.size < messages.size) {
                break;
            }
            lastId = messages.last().id;
        }

        const itemData = {};
        let totalCheckouts = 0; // Valid Successful Checkouts (Units Secured)
        let totalCancels = 0;   // Failed Checkout + Successful Checkout -> Order Cancelled...
        let totalDeclines = 0;  // Payment declined!
        let totalSpend = 0;
        let detectedSite = "Retailer";

        for (const msg of allMessages) {
            // 1. NEVER count messages sent by the PokeSluts ACO Bot itself (only count incoming webhooks)
            if (msg.author && msg.author.id === client.user.id) continue;
            if (!msg.embeds || msg.embeds.length === 0) continue;
            
            for (const embed of msg.embeds) {
                const rawTitle = (embed.title || "").trim();
                const title = rawTitle.toLowerCase();
                const fields = embed.fields || [];

                // Extra safety: skip any recap/summary embed
                if (title.includes('recap') || title.includes('summary')) continue;

                // 2. Exact Classification Mapping
                // - "Payment declined!" -> Decline
                // - "Failed Checkout" OR "Successful Checkout -> Order Cancelled..." -> Cancel
                // - "Successful Checkout!" (without cancel) -> Successful Checkout
                const isDecline = title.includes('payment declined');
                const isCancel = title.includes('failed checkout') || title.includes('order cancelled') || title.includes('order canceled');
                const isSuccess = !isCancel && !isDecline && title.includes('successful checkout');

                if (!isSuccess && !isCancel && !isDecline) continue;

                if (isDecline) {
                    totalDeclines += 1;
                    continue;
                }

                // Parse Product, Price, Quantity, Site, URL
                let rawProduct = "";
                let unitPrice = 0;
                let quantity = 1;
                let itemUrl = embed.url || "";

                fields.forEach(f => {
                    const name = (f.name || "").toLowerCase().trim();
                    if (name === 'product' || name === 'item') {
                        rawProduct = decodeHtml(f.value);
                    } else if (name === 'price' || name === 'cost') {
                        const parsed = parseFloat(f.value.replace(/[^0-9.]/g, ''));
                        if (!isNaN(parsed)) unitPrice = parsed;
                    } else if (name.includes('quant')) {
                        const parsed = parseInt(f.value.replace(/[^\d]/g, ''), 10);
                        if (!isNaN(parsed) && parsed > 0) quantity = parsed;
                    } else if (name === 'site') {
                        detectedSite = decodeHtml(f.value);
                    }
                });

                if (!rawProduct) continue;

                // Extract URL if wrapped in markdown [Name](url)
                const linkMatch = rawProduct.match(/\[(.*?)\]\((.*?)\)/);
                if (linkMatch) {
                    rawProduct = linkMatch[1];
                    itemUrl = linkMatch[2];
                }

                // Extract quantity prefix like "• 1x " or "- 1x "
                const qtyMatch = rawProduct.match(/^[•\-*\s]*(\d+)x\s+/i);
                if (qtyMatch) {
                    quantity = parseInt(qtyMatch[1], 10);
                    rawProduct = rawProduct.replace(qtyMatch[0], '').trim();
                }

                // Extract inline price like " - $14.99"
                if (rawProduct.includes(' - $')) {
                    const parts = rawProduct.split(' - $');
                    rawProduct = parts[0];
                    if (unitPrice === 0 && parts[1]) {
                        unitPrice = parseFloat(parts[1].replace(/[^0-9.]/g, '')) || 0;
                    }
                }

                // Standardize product name so Polar & Hāyhā logs merge into the exact same key
                let cleanName = rawProduct
                    .replace(/\s*[-–—]\s*default$/i, '')
                    .replace(/^\[|\]$/g, '')
                    .trim();

                if (!itemData[cleanName]) {
                    itemData[cleanName] = { 
                        checkouts: 0, 
                        cancels: 0, 
                        price: unitPrice, 
                        site: detectedSite,
                        url: itemUrl
                    };
                }

                if (unitPrice > 0 && itemData[cleanName].price === 0) {
                    itemData[cleanName].price = unitPrice;
                }
                if (itemUrl && !itemData[cleanName].url) {
                    itemData[cleanName].url = itemUrl;
                }

                if (isSuccess) {
                    itemData[cleanName].checkouts += quantity;
                    totalCheckouts += quantity;
                    totalSpend += (itemData[cleanName].price || unitPrice) * quantity;
                } else if (isCancel) {
                    itemData[cleanName].cancels += quantity;
                    totalCancels += quantity;
                }
            }
        }

        if (totalCheckouts === 0 && totalCancels === 0 && totalDeclines === 0) {
            return interaction.editReply(`No logs found in <#${LOGS_CHANNEL_ID}> for the last ${displayTitle}.`);
        }

        const totalOrdersPlaced = totalCheckouts + totalCancels;
        const stickRate = totalOrdersPlaced > 0 ? ((totalCheckouts / totalOrdersPlaced) * 100).toFixed(1) : '0.0';

        // Removed "Success" from title so even older parsers never confuse a Recap with a checkout
        const recapEmbed = new EmbedBuilder()
            .setTitle(`🎉 ${displayTitle} Drop Recap & Summary`)
            .setColor(3066993)
            .setDescription(
                `**Overview Stats:**\n` +
                `📦 **Total Orders Placed:** \`${totalOrdersPlaced}\`\n` +
                `✅ **Successful Checkouts:** \`${totalCheckouts}\`\n` +
                `❌ **Cancelled Orders:** \`${totalCancels}\`\n` +
                `🛑 **Payment Declines:** \`${totalDeclines}\`\n` +
                `💸 **Net Total Spend:** \`$${totalSpend.toFixed(2)}\`\n` +
                `📈 **Stick Rate:** \`${stickRate}%\`\n\n` +
                `**Item Breakdown:**`
            )
            .setFooter({ text: 'PokeSluts ACO Bot • Auto-Scraped' })
            .setTimestamp();

        for (const [itemName, data] of Object.entries(itemData)) {
            const linkText = data.url ? `\n**Link:** [Click Here](${data.url})` : '';
            recapEmbed.addFields({
                name: `🛒 ${itemName}`,
                value: `**Price:** \`$${data.price.toFixed(2)}\`\n**Checkouts:** \`${data.checkouts}\`\n**Cancels:** \`${data.cancels}\`${linkText}`,
                inline: true
            });
        }

        await interaction.editReply({ embeds: [recapEmbed] });
    }
});

client.login(process.env.BOT_TOKEN);
