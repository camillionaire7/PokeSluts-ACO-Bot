require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionsBitField, 
    EmbedBuilder,
    ChannelType
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// 1. Slash Command Registration
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
        .addChannelOption(option =>
            option.setName('log_channel')
                .setDescription('Select the channel containing your webhook logs')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
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

    await interaction.deferReply();

    const timeframeValue = interaction.options.getString('timeframe');
    const logsChannel = interaction.options.getChannel('log_channel');
    
    let hoursToScrub = 6;
    let displayTitle = "6-Hour";

    if (timeframeValue === '6h') { hoursToScrub = 6; displayTitle = "6-Hour"; }
    else if (timeframeValue === '24h') { hoursToScrub = 24; displayTitle = "24-Hour"; }
    else if (timeframeValue === '7d') { hoursToScrub = 24 * 7; displayTitle = "7-Day"; }
    else if (timeframeValue === '30d') { hoursToScrub = 24 * 30; displayTitle = "30-Day"; }

    const timeLimitMs = Date.now() - (hoursToScrub * 60 * 60 * 1000);
    
    let allMessages = [];
    let lastId;

    // 2. Fetch all messages from the selected channel
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

    // 3. Parse Polar & Hāyhā Embeds
    const itemData = {};
    let totalCheckouts = 0;
    let totalCancels = 0;
    let totalSpend = 0;

    for (const msg of allMessages) {
        if (!msg.embeds || msg.embeds.length === 0) continue;
        
        const embed = msg.embeds[0];
        const title = (embed.title || "").toLowerCase();
        
        // Exact status detection
        const isCancel = title.includes('cancelled') || title.includes('canceled') || title.includes('declined') || title.includes('failed');
        const isSuccess = !isCancel && title.includes('successful checkout');

        if (!isSuccess && !isCancel) continue;

        let rawProduct = "";
        let price = 0;
        let site = "";

        // Extract fields
        embed.fields.forEach(f => {
            const name = f.name.toLowerCase();
            if (name === 'product' || name === 'item') {
                rawProduct = f.value;
            } else if (name === 'price') {
                price = parseFloat(f.value.replace(/[^0-9.]/g, '')) || 0;
            } else if (name === 'site') {
                site = f.value;
            }
        });

        if (!rawProduct) continue;

        // Clean up Hāyhā item format: "Pokemon ETB - $69.99"
        if (rawProduct.includes(' - $')) {
            const parts = rawProduct.split(' - $');
            rawProduct = parts[0];
            if (price === 0 && parts[1]) {
                price = parseFloat(parts[1].replace(/[^0-9.]/g, '')) || 0;
            }
        }

        // Clean up Polar format: "• 2x Pokemon Booster Bundle - Default"
        let cleanName = rawProduct
            .replace(/\[(.*?)\]\(.*?\)/g, '$1') // remove markdown links
            .replace(/^[•\s\d+x]+/i, '')          // remove leading bullets & "2x"
            .replace(/\s*-\s*default$/i, '')     // remove trailing "- Default"
            .trim();

        if (!itemData[cleanName]) {
            itemData[cleanName] = { 
                checkouts: 0, 
                cancels: 0, 
                price: price, 
                site: site || "Retailer" 
            };
        }

        if (price > 0 && itemData[cleanName].price === 0) {
            itemData[cleanName].price = price;
        }

        if (isSuccess) {
            itemData[cleanName].checkouts += 1;
            totalCheckouts += 1;
            totalSpend += (itemData[cleanName].price || price);
        } else if (isCancel) {
            itemData[cleanName].cancels += 1;
            totalCancels += 1;
        }
    }

    if (totalCheckouts === 0 && totalCancels === 0) {
        return interaction.editReply(`No checkout or cancellation logs found in <#${logsChannel.id}> for the last${displayTitle}.`);
    }

    // 4. Calculate Stick Rate & Build the Drop Card Embed
    const totalAttempts = totalCheckouts + totalCancels;
    const stickRate = totalAttempts > 0 ? ((totalCheckouts / totalAttempts) * 100).toFixed(1) : 0;

    const recapEmbed = new EmbedBuilder()
        .setTitle(`🎉 ${displayTitle} Drop Recap - ACO Success`)
        .setColor(16724911)
        .setDescription(`**Overview Stats:**\n📦 **Total Checkouts:** \`${totalCheckouts}\`\n💸 **Total Spend:** \`$${totalSpend.toFixed(2)}\`\n📈 **Stick Rate:** \`${stickRate}%\`\n\n**Scrubbed Source:** <#${logsChannel.id}>\n\n**Item Breakdown:**`)
        .setFooter({ text: 'PokeSluts ACO Bot • Auto-Scraped' })
        .setTimestamp();

    for (const [itemName, data] of Object.entries(itemData)) {
        recapEmbed.addFields({
            name: `🛒 ${itemName}`,
            value: `**Site:** \`${data.site}\`\n**Est. Price:** \`$${data.price.toFixed(2)}\`\n**Checkouts:** \`${data.checkouts}\`\n**Cancels/Fails:** \`${data.cancels}\``,
            inline: true
        });
    }

    // 5. Send finished recap
    await interaction.editReply({ embeds: [recapEmbed] });
});

client.login(process.env.BOT_TOKEN);
