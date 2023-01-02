"use strict";
const k8s = require('@kubernetes/client-node');
const { MoleculerRetryableError, MoleculerClientError } = require("moleculer").Errors;
const stream = require('stream');

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
		topNodes: {
			params: {
				cluster: { type: "string", optional: false },
			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.cluster)
				return k8s.topNodes(config.api.CoreV1Api)
			}
		},
		topPods: {
			params: {
				cluster: { type: "string", optional: false },
				namespace: { type: "string", optional: false },
			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.cluster)
				return k8s.topPods(config.api.CoreV1Api, config.metrics, ctx.params.namespace)
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

				const list = [...core, ...apps, ...batch, ...tekton]

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

				const res = await ctx.call('v1.kube.get', {
					uid: params.uid
				})

				if (!res) {
					throw Error('not found')
				}

				const query = `sum(node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate{namespace="${res.metadata.namespace}", pod="${res.metadata.name}"})`
				const start = new Date().getTime() - 24 * 60 * 60 * 1000;
				const end = new Date();

				return this.prom.series(query, start, end)
					.then((res) => {
						this.logger.info(res)
						return res
					});
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
					cluster: config.name,
					phase: phase.toLocaleLowerCase()
				}

				delete event.metadata.managedFields

				let emit = true;
				switch (phase) {
					case 'ADDED':
						if (this.cache.has(resource.metadata.uid)) {
							emit = false;
						}
					case 'MODIFIED':
						this.cache.set(resource.metadata.uid, event)
						break;
					case 'DELETED':
						this.cache.delete(resource.metadata.uid)
						break;
					default:
						break;
				}


				if (emit && events.includes(phase)) {
					this.broker.emit(`kube.${api}.${phase.toLocaleLowerCase()}`, event)
				}
			}, (err) => {
				delete this.kubeEvents[`${cluster}-${api}`];
				setTimeout(() => {
					this.watchAPI(config, api, events)
				}, err ? 5000 : 100)
			})
		},
	},
	/**
	 * Service created lifecycle event handler
	 */
	created() {
		this.cache = new Map()
		this.configs = new Map()
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
						console.log(res.body, properties)
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
