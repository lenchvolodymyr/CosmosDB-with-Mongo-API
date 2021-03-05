const vm = require('vm');
const connectionHelper = require('../../reverse_engineering/helpers/connectionHelper');

const applyToInstanceHelper = {
	async applyToInstance(data, logger, cb) {
		let connection;
		
		try {
			connection = await connect(data, logger);

			const mongodbScript = replaceUseCommand(data.script);
			await runMongoDbScript({
				mongodbScript,
				logger,
				connection
			});

			connection.close();
			cb(null);
		} catch (error) {
			error = {
				message: error.message,
				stack: error.stack,
			};
			logger.log('error', error);

			if (connection) {
				connection.close();
			}

			cb(error);
		}
	},

	testConnection(connectionInfo, logger, cb){
		connect(connectionInfo, logger).then((connection) => {
			connection.close();
			cb(false);
		}, error => {
			cb(true);
		});
	},
};

const connect = (connectionInfo, logger) => {
	logger.clear();
	logger.log('info', connectionInfo, 'Reverse-Engineering connection settings', connectionInfo.hiddenKeys);

	return connectionHelper.connect(connectionInfo).then((connection) => {
		logger.log('info', { message: 'successfully connected' });

		return connection;
	}).catch(error => {
		logger.log('error', {
			message: error.message,
			stack: error.stack,
			error,
		});

		return Promise.reject(error);
	})
};

const replaceUseCommand = (script) => {
	return script.split('\n').filter(Boolean).map(line => {
		const useStatement = /^use\ ([\s\S]+);$/i;
		const result = line.match(useStatement);

		if (!result) {
			return line;
		}

		return `useDb("${result[1]}");`;
	}).join('\n');
};

const runMongoDbScript = ({ mongodbScript, logger: loggerInstance, connection }) => {
	let currentDb;
	let commands = [];
	const logger = createLogger(loggerInstance);

	logger.info('Start applying instance ...');

	const context = {
		useDb(dbName) {
			currentDb = dbName;
		},

		db: {
			getCollection(collectionName) {
				const db = connection.db(currentDb);
				const collection = db.collection(collectionName);

				return {
					createIndex(fields, params) {
						const indexName = params.name || '';
						const command = () => collection.createIndex(fields, params).then(() => {
							logger.info(`index ${indexName} created`);
						}, (error) => {
							logger.error(error, `index ${indexName} not created`);

							return Promise.reject(error);
						});

						commands.push(command);
					},
					insert(data) {
						const command = () => collection.insertOne(data).then(() => {
							logger.info(`sample inserted`);
						}).catch(error => {
							logger.error(error, `sample is not inserted: ${error.message}`);

							return Promise.reject(error);
						});

						commands.push(command);
					}
				};
			},
			runCommand(commandData) {
				const db = connection.db(currentDb);

				const command = () => db.command(commandData).then(() => {
					logger.info('Create sharding');
				}).catch(error => {
					if (error.codeName === 'NamespaceExists') {
						logger.warning('shard key is not created:  ' + error.message, error);
					} else {
						logger.error(error, 'error of creation sharding');

						return Promise.reject(error);
					}
				});

				commands.push(command);
			}
		}
	};

	vm.createContext(context);
	vm.runInContext(mongodbScript, context);

	return commands.reduce((prev, next) => {
		return prev.then(() => next());
	}, Promise.resolve());
};

const createLogger = logger => ({
	info(message) {
		logger.progress({
			message: `${message}`,
		});
		logger.log('info', {
			message,
		});
	},
	error(error, message) {
		logger.progress({
			message: `[color:red]failed: ${message}`,
		});
		logger.log('error', {
			message: error.message,
			stack: error.stack,
		}, message);
	},
	warning(message, error) {
		logger.progress({
			message: `[color:orange]warning: ${message}`,
		});
		if (error) {
			logger.log('error', {
				message: error.message,
				stack: error.stack,
			}, message);
		}
	}
});

module.exports = applyToInstanceHelper;
