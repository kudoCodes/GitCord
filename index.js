// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { Client, Collection, Events, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const { token, dbUrl, dbName, collectionName, websiteURL } = require('./config.json');
const { MongoClient } = require("mongodb");

let collection;
async function run()
{
	const mongoClient = new MongoClient(dbUrl);
	await mongoClient.connect();
	const database = mongoClient.db(dbName);
	collection = database.collection(collectionName);
	const app = express();
	const port = 3000;
	
	// to run server -> NGROKAUTHTOKEN node index.js
	
	// Parse incoming GitHub payloads as JSON	

	app.use(bodyParser.json());
	
	app.post('/', async (req, res) => {
		const payload = req.body;

		if (!payload || !payload.ref) {
			console.error('No payload received, prob init webhook');
			return res.status(200).send('No payload received');
		}
		console.log('GitHub webhook payload received:');
		// Extract relevant information from the GitHub payload
		const { pusher, repository, ref, head_commit, deleted } = payload;
		const branch = ref.split('/').pop().toLowerCase(); // Get branch name
		let commitMessage = head_commit ? head_commit.message : 'No commit message provided';
		if (deleted)
		{
			commitMessage = 'Branch deletion ' + branch;
		}
		const author = pusher ? pusher.name : payload.sender.login;
	
		// Construct a message for Discord
		const discordEmbed = new EmbedBuilder()
			.setColor('#00ff00')
			.setTitle(`New Event on ${repository.name}`)
			.setDescription(`Branch: ${branch}\nAuthor: ${author}\nMessage: ${commitMessage}`)
			.setURL(head_commit ? head_commit.url : repository.html_url)
			.setFooter({ text: 'GitHub -> Discord Integration' })
			.setTimestamp();
	
		// Forward the message to the Discord webhook
		const discordWebhookUrl = await findWebhook(repository.name.toLowerCase());
		const guildId = await findGuildId(repository.name.toLowerCase());

		if(!guildId || !discordWebhookUrl){
			console.error("No webhook or guild id found for " + repository.name);
			return res.status(400).send("No webhook or guild id found for " + repository.name);
		}
		//Get guild from guild id
		const guild = client.guilds.cache.get(guildId);

		if(!guild){
			console.error("No guild found for " + guildId);
			return res.status(400).send("No guild found for " + guildId);
		}
		//Check if channel for branch exists
		let branchChannel = guild.channels.cache.find(channel => channel.name.toLowerCase() === branch.toLowerCase() && channel.type === ChannelType.GuildText && channel.parent.name.toLowerCase() === repository.name.toLowerCase());
		console.log("Branch channel: " + branchChannel);
		const categoryChannel = guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === repository.name.toLowerCase());
		if (deleted)
		{
			console.log('Branch deleted, deleting channel');
			await branchChannel.delete();
		}
		else
		{
			if (!branchChannel)
			{
				try{
					branchChannel = await guild.channels.create({
						name: branch,
						type: ChannelType.GuildText,
						parent: categoryChannel.id,
					});
					console.log("Channel created: ${branchChannel.name}");
				}catch(error){
					console.error("Error creating channel: "+ error);
					return res.status(400).send("Error creating channel: ${error}");
				}
			}
			try {
				// Send the message to the branch channel
				await branchChannel.send({ embeds: [discordEmbed] });
				console.log('Message sent to branch channel');
			} catch (error) {
				console.error('Error sending message to branch channel: ' + error);
				return res.status(500).send('Error sending message to branch channel:' +error);
			}
		}
	
		// Now send the message to the webhook (all channel)
		try {
			await axios.post(discordWebhookUrl, {
				embeds: [discordEmbed.toJSON()]
			});
			console.log('Message sent to Discord via webhook!');
			return res.status(200).send('Webhook received and message sent to Discord!');
		} catch (error) {
			console.error('Error sending message to Discord via webhook:', error);
			return res.status(500).send('Failed to send message to Discord via webhook');
		}
	});
	
	app.listen(port, () => {
		console.log(`GitHub webhook listener running on port ${port}`);
	});
	

	// Create a new client instance
	const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
	
	// When the client is ready, run this code (only once).
	client.once('ready', async () => {
		console.log('Bot is online!');
	});
	
	
	// Log in to Discord with your client's token
	client.login(token);
	
	client.commands = new Collection();
	
	const foldersPath = path.join(__dirname, 'commands');
	const commandFolders = fs.readdirSync(foldersPath);
	
	for (const folder of commandFolders) {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const command = require(filePath);
			// Set a new item in the Collection with the key as the command name and the value as the exported module
			if ('data' in command && 'execute' in command) {
				client.commands.set(command.data.name, command);
			} else {
				console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
			}
		}
	}
	
	client.on(Events.InteractionCreate, async interaction => {
		if (!interaction.isChatInputCommand()) return;
	
		const command = interaction.client.commands.get(interaction.commandName);
	
		if (!command)
		{
			console.error("No command matching " + interaction.commandName +  " was found");
			return;
		}
		try {
			await command.execute(interaction);
		} catch (error) {
			console.error(error);
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: "there was an error while exec this command :(", ephemeral: true});
			} else {
				await interaction.reply({ content: "there was an error while exec this command :(", ephemeral: true});
	
			}
		}
	});
}

async function findWebhook(repoName)
{
	const projection = {[repoName] : {'$exists': 1}}; // Use square brackets for dynamic field name
    const webhook = await collection.findOne(projection);

    if (webhook && webhook[repoName]) {
      console.log(`Webhook found for ${repoName}:`, webhook[repoName].values.webhook);
      return webhook[repoName].values.webhook; // Return the value associated with the repoName field
    } else {
      console.log(`No webhook found for ${repoName}`);
      return null;
    }
}

async function findGuildId(repoName)
{
	const projection = {[repoName] : {'$exists': 1}}; // Use square brackets for dynamic field name
	const webhook = await collection.findOne(projection);

	if (webhook && webhook[repoName]) {
	  console.log(`Guild id found for ${repoName}:`, webhook[repoName].values.guild);
	  return webhook[repoName].values.guild; // Return the value associated with the repoName field
	} else {
	  console.log(`No Guild id found for ${repoName}`);
	  return null;
	}
}

async function addValues(repoName, webhookUrl, guildId)
{
	const add = { [repoName]: {values : 
			{
				webhook : webhookUrl,
				guild : guildId
			}
		}
	};


	await collection.insertOne(add);

	console.log(`Repo info populated for ${repoName}:`);
}

async function deleteRepo(repoName)
{
	const projection = {[repoName] : {'$exists': 1}}; // Use square brackets for dynamic field name
	await collection.deleteOne(projection);
}

exports.deleteRepo = deleteRepo;
exports.findWebhook = findWebhook;
exports.addValues = addValues;
exports.findGuildId = findGuildId;

run().catch(console.dir);
