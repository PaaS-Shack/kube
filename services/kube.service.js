"use strict";
const k8s = require('@kubernetes/client-node');
const { MoleculerRetryableError, MoleculerClientError } = require("moleculer").Errors;
const stream = require('stream');

const Datastore = require('../lib/nedb/index');
const { Console } = require('console');

function getClassMethods(className) {
	if (!(className instanceof Object)) {
		throw new Error("Not a class");
	}
	let ret = new Set();

	const blockList = [
		'constructor',
		'setDefaultAuthentication',
		'setApiKey',
		'addInterceptor',
		'__defineGetter__',
		'__defineSetter__',
		'hasOwnProperty',
		'__lookupGetter__',
		'__lookupSetter__',
		'isPrototypeOf',
		'propertyIsEnumerable',
		'toString',
		'valueOf',
		'toLocaleString'
	]

	function methods(obj) {
		if (obj) {
			let ps = Object.getOwnPropertyNames(obj);

			ps.forEach(p => {
				if (blockList.includes(p)) {
					return;
				}
				if (obj[p] instanceof Function) {
					ret.add(p);
				} else {
					//can add properties if needed
				}
			});

			methods(Object.getPrototypeOf(obj));
		}
	}

	methods(className.prototype);

	return Array.from(ret);
}

function $args(func) {
	return (func + '')
		.replace(/[/][/].*$/mg, '') // strip single-line comments
		.replace(/\s+/g, '') // strip white space
		.replace(/[/][*][^/*]*[*][/]/g, '') // strip multi-line comments  
		.split('){', 1)[0].replace(/^[^(]*[(]/, '') // extract the parameters  
		.replace(/=[^,]+/g, '') // strip any ES6 defaults  
		.split(',').filter(Boolean); // split & filter [""]
}

const apis = ['CoreV1Api', 'NetworkingV1Api', 'AppsV1Api', 'NodeV1beta1Api', 'BatchV1Api',
	'AuthenticationV1Api', 'CertificatesV1Api', 'DiscoveryV1beta1Api', 'EventsV1beta1Api',
	'PolicyV1beta1Api', 'StorageV1beta1Api', 'CustomObjectsApi']
const core = ['pods', 'endpoints', 'services', 'persistentvolumeclaims', 'events', 'nodes',
	'resourcequotas', 'namespaces', 'limitranges']
const apps = ['replicasets', 'deployments', 'statefulsets', 'daemonsets']
const batch = ['jobs', 'cronjobs']
const tekton = ['pipelineruns', 'pipelines', 'taskruns']

function flattenObject(ob) {
	var toReturn = {};

	for (var i in ob) {
		if (!ob.hasOwnProperty(i)) continue;

		if ((typeof ob[i]) == 'object' && ob[i] !== null) {
			var flatObject = flattenObject(ob[i]);
			for (var x in flatObject) {
				if (!flatObject.hasOwnProperty(x)) continue;

				toReturn[i + '.' + x] = flatObject[x];
			}
		} else {
			toReturn[i] = ob[i];
		}
	}
	return toReturn;
}


/**
 * attachments of addons service
 */
module.exports = {
	name: "kube",
	version: 1,

	mixins: [],

	/**
	 * Service dependencies
	 */
	dependencies: [],

	/**
	 * Service settings
	 */
	settings: {
		rest: '/v1/kube/',
	},

	/**
	 * Actions
	 */

	actions: {
		applyTLS: {
			params: {
				cluster: { type: "string", default: 'default', optional: true },
				namespace: { type: "string", optional: false },
				name: { type: "string", optional: false },
				domain: { type: "string", optional: false },
			},
			async handler(ctx) {
				const { name, namespace, cluster, domain } = Object.assign({}, ctx.params);
				const config = this.configs.get(cluster)


				const certificate = await ctx.call('v1.certificates.resolveDomain', {
					domain
				})


				const secret = {
					"apiVersion": "v1",
					"data": {
						"tls.crt": Buffer(certificate.cert).toString('base64'),
						"tls.key": Buffer(certificate.privkey).toString('base64')
					},
					"kind": "Secret",
					"metadata": {
						"name": name,
						"namespace": namespace
					},
					"type": "kubernetes.io/tls"
				}

				return this.actions.readNamespacedSecret({
					name, namespace, cluster
				})
					.then(() => {
						return this.actions.patchNamespacedSecret({
							name, namespace, cluster, body: secret
						})
					}).catch(() => {
						return this.actions.createNamespacedSecret({
							name, namespace, cluster, body: secret
						})
					})
			}
		},
		topNodes: {
			params: {
				cluster: { type: "string", default: 'default', optional: true },
			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.cluster)
				return config.metrics.getNodeMetrics()
			}
		},
		topPods: {
			params: {
				cluster: { type: "string", default: 'default', optional: true },
				namespace: { type: "string", optional: true },
				name: { type: "string", optional: true },

			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.cluster)
				return config.metrics.getPodMetrics(ctx.params.namespace, ctx.params.name).then((res) => res.items[0])

			}
		},
		logs: {
			params: {
				name: { type: "string", optional: false },
				namespace: { type: "string", optional: false },
				cluster: { type: "string", default: 'default', optional: true },
			},
			async handler(ctx) {
				const { name, namespace, cluster } = Object.assign({}, ctx.params);
				const config = this.configs.get(cluster)

				const logStream = new stream.PassThrough();

				const chunk = []

				logStream.on('data', (c) => {
					chunk.push(c.toString());
				});

				await config.logger.log(namespace, name, undefined, logStream, { follow: false, tailLines: 50, pretty: false, timestamps: false })
				return new Promise((resolve) => logStream.on('end', () => resolve(chunk)))

			}
		},
		loadConfig: {
			params: {
				name: { type: "string", optional: false },
				path: { type: "string", optional: false },
			},
			async handler(ctx) {
				const { name, path } = Object.assign({}, ctx.params);

				const config = { name, path, api: {} }

				config.kc = new k8s.KubeConfig();
				config.kc.loadFromFile(path)

				config.metrics = new k8s.Metrics(config.kc);
				config.watch = new k8s.Watch(config.kc);
				config.logger = new k8s.Log(config.kc);

				for (let index = 0; index < apis.length; index++) {
					const key = apis[index];
					config.api[key] = config.kc.makeApiClient(k8s[key]);
					this.logger.info(`Loading api ${key} for cluster ${name}`)
				}
				this.configs.set(name, config)

				const list = [...core, ...apps, ...batch]

				for (let index = 0; index < list.length; index++) {
					this.watchAPI(config, list[index], ['ADDED', 'MODIFIED', 'DELETED'])
				}

			}
		},
		top: {
			rest: [
				'GET /top/:uid'
			],
			params: {
				uid: { type: "string", optional: false },
			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				let cpu = 0
				let memory = 0
				return new Promise((resolve, reject) => {

					this.db.findOne({
						_id: params.uid
					}).exec((err, doc) => {
						if (err) {
							reject(err)
						} else {
							this.db.findOne({
								_id: doc.metadata.name
							}).exec((err, doc) => {
								if (err) {
									reject(err)
								} else {
									if (!doc)
										return resolve({
											cpu, memory
										})
									for (let index = 0; index < doc.containers.length; index++) {
										const { usage } = doc.containers[index];
										cpu += parseInt(usage.cpu.match(/-?\d+\.?\d*/))
										memory += parseInt(usage.memory.match(/-?\d+\.?\d*/))
										console.log(usage.memory)
									}
									resolve({
										cpu: cpu / 1000000000, memory
									})
								}
							});
						}
					});
				})
			}
		},
		findOne: {
			params: {

			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				const fields = {}
				const sort = {}

				if (Array.isArray(params.fields)) {
					for (let index = 0; index < params.fields.length; index++) {
						const element = params.fields[index];
						fields[element] = 1
					}
					delete params.fields
				} else if (params.fields) {
					fields[params.fields] = 1
					delete params.fields
				}
				if (Array.isArray(params.sort)) {
					for (let index = 0; index < params.sort.length; index++) {
						const element = params.sort[index];
						sort[element] = 1
					}
					delete params.sort
				} else if (params.sort) {
					sort[params.sort] = 1
					delete params.sort
				}

				return new Promise((resolve, reject) => {
					console.log(flattenObject(params), fields, sort)
					this.db.findOne({ ...flattenObject(params) }, fields).sort(sort).exec(function (err, docs) {
						if (err) {
							reject(err)
						} else {
							resolve(docs)
						}
					});
				})
			}
		},
		find: {
			params: {

			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				const fields = {}
				const sort = {}

				if (Array.isArray(params.fields)) {
					for (let index = 0; index < params.fields.length; index++) {
						const element = params.fields[index];
						fields[element] = 1
					}
					delete params.fields
				} else if (params.fields) {
					fields[params.fields] = 1
					delete params.fields
				}
				if (Array.isArray(params.sort)) {
					for (let index = 0; index < params.sort.length; index++) {
						const element = params.sort[index];
						sort[element] = 1
					}
					delete params.sort
				} else if (params.sort) {
					sort[params.sort] = 1
					delete params.sort
				}
				return new Promise((resolve, reject) => {
					this.db.find({ ...flattenObject(params) }, fields).sort(sort).exec(function (err, docs) {
						if (err) {
							reject(err)
						} else {
							resolve(docs)
						}
					});
				})
			}
		},
		get: {
			rest: [
				'GET /query/:namespace/:kind',
				'GET /query/:uid'
			],
			params: {
				uid: { type: "string", optional: true },
				kind: { type: "string", optional: true },
				namespace: { type: "string", optional: true },
			},
			async handler(ctx) {
				const { uid, kind, namespace } = Object.assign({}, ctx.params);

				if (uid) {
					return this.cache.get(uid)
				}

				const filter = (res) => {
					if (namespace)
						return res.kind == kind && res.metadata.namespace == namespace
					else
						return res.kind == kind
				}
				const result = [];

				if (kind) {
					for (const res of this.cache.values()) {
						if (filter(res)) {
							result.push(res)
						}
					}
				} else if (namespace) {
					for (const res of this.cache.values()) {
						if (res.metadata.namespace == namespace) {
							result.push(res)
						}
					}
				} else {
					result.push(...Array.from(this.cache.values()))
				}
				return result;
			}
		}
	},

	/**
	 * Events
	 */
	events: {

	},

	/**
	 * Methods
	 */
	methods: {
		stopWatch() {
			if (this.kubeEvents) {
				Object.keys(this.kubeEvents).forEach((key) => {
					this.logger.info(`Stop watching ${key}`)
					this.kubeEvents[key].abort();
				})
			}
		},
		startWatch() {
			if (this.kubeEvents) {
				return;
			}
			this.kubeEvents = {}

			if (process.env.CONFIGS) {
				const configs = JSON.parse(process.env.CONFIGS);
				this.logger.info(`Loading configs`, configs)
				setTimeout(async () => {
					if (this.closed) return;
					for (let index = 0; index < configs.length; index++) {
						const config = configs[index];
						await this.actions.loadConfig({
							path: config.path,
							name: config.name
						})
					}
				}, 1000)
			}
		},
		async watchAPI(config, api, events = ['ADDED', 'MODIFIED', 'DELETED']) {
			if (this.closed) return;

			const cluster = config.name;

			let path = `/api/v1/${api}`;


			if (apps.includes(api)) {
				path = `/apis/apps/v1/${api}`;
			} else if (batch.includes(api)) {
				path = `/apis/batch/v1/${api}`;
			} else if (tekton.includes(api)) {
				path = `/apis/tekton.dev/v1beta1/${api}`;
			}

			this.logger.info(`loading kube api ${path}`)


			this.kubeEvents[`${cluster}-${api}`] = await config.watch.watch(path, {}, (phase, resource) => {

				const event = {
					...resource,
					_id: resource.metadata.uid,
					cluster: config.name,
					phase: phase.toLocaleLowerCase()
				}

				const kind = event.kind.toLocaleLowerCase()

				delete event.metadata.managedFields
				if (event.phase == 'deleted') {
					this.db.remove({ _id: event._id }, {}, (err, numRemoved) => {
						if (err) {
							console.log(event, err)
						}
						this.broker.emit(`kube.${kind}s.deleted`, event)
					});
				} else {
					this.db.findOne({ _id: event._id }, (err, docs) => {
						if (err) {
							console.log(event, err)
						} else {
							let isNew = !docs
							this.db.update({ _id: event._id }, event, {
								upsert: true
							}, (err, numAffected, affectedDocuments, upsert) => {
								if (err) {
									console.log(event, err)
								} else {
									this.broker.emit(`kube.${kind}s.${isNew ? 'added' : 'modified'}`, event)
								}
							});
						}
					});
				}
			}, (err) => {
				if (err) {
					console.log(err)
				}
				delete this.kubeEvents[`${cluster}-${api}`];
				setTimeout(() => {
					this.watchAPI(config, api, events)
				}, err ? 5000 : 100)
			})
		},
		getUsage(doc) {
			const result = {
				cpu: 0,
				memory: 0,
				containers: 0,
			}
			if (doc) {
				for (let index = 0; index < doc.containers.length; index++) {
					const { usage, name } = doc.containers[index];
					result.cpu += parseInt(usage.cpu.match(/-?\d+\.?\d*/)) / 1000000
					result.memory += parseInt(usage.memory.match(/-?\d+\.?\d*/)) / 1024
					result.containers++;
				}
			}
			return result
		},
		async update(query, update) {
			return new Promise((resolve, reject) => {
				this.db.update(query, update, {
					upsert: true
				}, (err, numAffected, affectedDocuments, upsert) => {
					if (err) {
						reject(err)
					} else {
						this.db.findOne(query, (err, doc) => err ? reject(err) : resolve(doc))
					}
				})
			})
		},
		async findOne(query) {
			return new Promise((resolve, reject) => {
				this.db.findOne(query, (err, doc) => err ? reject(err) : resolve(doc))
			})
		},
	},
	/**
	 * Service created lifecycle event handler
	 */
	created() {
		this.cache = new Map()
		this.configs = new Map()
		this.db = new Datastore();
	},

	/**
	 * Service started lifecycle event handler
	 */
	async started() {
		this.closed = false
		this.startWatch()
	},

	/**
	 * Service stopped lifecycle event handler
	 */
	stopped() {
		this.closed = true
		return this.stopWatch()
	}
};


function generateAPI(name) {
	const api = k8s[name]
	const list = getClassMethods(api)

	for (let index = 0; index < list.length; index++) {
		const key = list[index];
		const args = $args(api.prototype[key].toString());
		const keySplit = key.split(/(?=[A-Z])/)
		const namespaced = keySplit[1].includes('Namespace')
		const type = keySplit[0]
		let rest = '';
		const params = {
			cluster: { type: "string", default: 'default', optional: true },
		}

		if (type == 'connect' || !!module.exports.actions[`${key}`]) {
			continue;
		}
		switch (type) {
			case 'read':
			case 'list':
			case 'get':
				rest += 'GET '
				break;
			case 'patch':
				rest += 'PATCH '
				break;
			case 'replace':
				rest += 'POST '
				break;
			case 'create':
				rest += 'POST '
				break;
			case 'delete':
				rest += 'DELETE '
				break;
			default:
				break;
		}

		if (namespaced) {
			rest += '/cluster/:namespace'
		}


		const method = keySplit.slice(namespaced ? 2 : 1).join('')
		rest += `/${method.toLocaleLowerCase()}`

		if (args[0] == 'name') {
			rest += '/:name'
		}

		const known = {
			name: { type: "string", optional: false },
			namespace: { type: "string", default: 'default', optional: true },
			pretty: { type: "boolean", default: true, optional: true },
			//dryRun: { type: "string", default: 'All', optional: true },
			body: { type: "object", optional: false },
			group: { type: "string", optional: false },
			version: { type: "string", optional: false },
			plural: { type: "string", optional: false },
		}


		for (let index = 0; index < args.length; index++) {
			const element = args[index];
			if (known[element]) {
				params[element] = known[element]
			} else {
				break;
			}
		}


		module.exports.actions[`${key}`] = {
			rest,
			description: "Add members to the addon",
			params,
			cache: false,
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				const properties = []
				for (let index = 0; index < args.length; index++) {
					const element = args[index];
					if (known[element]) {
						properties.push(params[element])
					} else {
						if (element == 'limit') {
							properties.push(1000)
						} else {
							properties.push(undefined)
						}
					}
				}

				const config = this.configs.get(params.cluster);
				if (!config) {
					throw (`Config '${params.config}' not found`)
				}

				return config.api[name][`${key}`](...properties)
					.then((res) => {
						return res.body
					}).catch((res) => {
						//console.log(res.body, properties)
						throw new MoleculerClientError(
							res.body.message,
							res.body.code,
							res.body.reason
						);
					});
			}
		}
	}
}

for (let index = 0; index < apis.length; index++) {
	const api = apis[index];
	generateAPI(api);
}
