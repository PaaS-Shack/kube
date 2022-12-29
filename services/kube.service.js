"use strict";
const k8s = require('@kubernetes/client-node');
const { MoleculerRetryableError, MoleculerClientError } = require("moleculer").Errors;

const { PrometheusDriver } = require('prometheus-query')

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

const methods = [
	{
		type: 'create',
		namespace: true,
		name: false,
		body: true
	},
	{
		type: 'list',
		namespace: true,
		name: false,
		body: false
	},
	{
		type: 'read',
		namespace: true,
		name: true,
		body: false
	},
	{
		type: 'patch',
		namespace: true,
		name: true,
		body: true
	},
	{
		type: 'delete',
		namespace: true,
		name: true,
		body: false
	}
]

const api = [{
	type: 'DaemonSet',
	api: 'AppsV1Api',
	methods
}, {
	type: 'Deployment',
	api: 'AppsV1Api',
	methods
}, {
	type: 'ReplicaSet',
	api: 'AppsV1Api',
	methods
}, {
	type: 'StatefulSet',
	api: 'AppsV1Api',
	methods
},
/*****
 * 
 * 
 */
{
	type: 'Namespace',
	namespace: false,
	api: 'CoreV1Api',
	methods
},
{
	type: 'Pod',
	namespace: true,
	api: 'CoreV1Api',
	methods
},
{
	type: 'ServiceAccount',
	namespace: true,
	api: 'CoreV1Api',
	methods
},
{
	type: 'Service',
	namespace: true,
	api: 'CoreV1Api',
	methods
},
{
	type: 'ConfigMap',
	namespace: true,
	api: 'CoreV1Api',
	methods
},
{
	type: 'Endpoints',
	namespace: true,
	api: 'CoreV1Api',
	methods
}, {
	type: 'Event',
	namespace: true,
	api: 'CoreV1Api',
	methods
}, {
	type: 'PersistentVolumeClaim',
	namespace: true,
	api: 'CoreV1Api',
	methods
}, {
	type: 'ReplicationController',
	namespace: true,
	api: 'CoreV1Api',
	methods
}, {
	type: 'ResourceQuota',
	namespace: true,
	api: 'CoreV1Api',
	methods
}, {
	type: 'Secret',
	namespace: true,
	api: 'CoreV1Api',
	methods
},
/**
 * 
 * 
 */
{
	type: 'Node',
	namespace: false,
	api: 'CoreV1Api',
	methods
},
/**
 * 
 * 
 */
{
	type: 'CronJob',
	namespace: true,
	api: 'BatchV1Api',
	methods
},
{
	type: 'Job',
	namespace: true,
	api: 'BatchV1Api',
	methods

},
/**
 * 
 * 
 */
{
	type: 'Ingress',
	namespace: false,
	api: 'NetworkingV1Api',
	methods
}, {
	type: 'NetworkPolicy',
	namespace: false,
	api: 'NetworkingV1Api',
	methods
}
]
const core = ['pods', 'endpoints', 'services', 'persistentvolumeclaims', 'events', 'nodes', 'resourcequotas', 'namespaces']
const apps = ['replicasets', 'deployments', 'statefulsets', 'daemonsets']
const batch = ['jobs', 'cronjobs']
/**
 * attachments of addons service
 */
module.exports = {
	name: "kube",
	version: 1,

	mixins: [


	],

	/**
	 * Service dependencies
	 */
	dependencies: [

	],

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
				name: { type: "string", optional: false },
			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.name)
				return k8s.topNodes(config.api.CoreV1Api)
			}
		},
		topPods: {
			params: {
				name: { type: "string", optional: false },
				namespace: { type: "string", optional: false },
			},
			async handler(ctx) {
				const config = this.configs.get(ctx.params.name)
				return k8s.topPods(config.api.CoreV1Api, config.metrics, ctx.params.namespace)
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
				const apis = ['AppsV1Api', 'NetworkingV1Api', 'BatchV1Api', 'CoreV1Api']

				for (let index = 0; index < apis.length; index++) {
					const key = apis[index];
					config.api[key] = config.kc.makeApiClient(k8s[key]);
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
				}, 100)
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
	console.log(name)
	const list = getClassMethods(api)

	for (let index = 0; index < list.length; index++) {
		const key = list[index];
		const args = $args(api.prototype[key].toString());
		const keySplit = key.split(/(?=[A-Z])/)
		const namespaced = keySplit[1].includes('Namespace')
		const type = keySplit[0]
		let rest = '';
		const params = {
			config: { type: "string", default: 'default', optional: true },
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
			body: { type: "object", optional: false }
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

				const config = this.configs.get(params.config);
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


generateAPI('CoreV1Api');
generateAPI('NetworkingV1Api');
generateAPI('AppsV1Api');
generateAPI('NodeV1beta1Api');
generateAPI('BatchV1Api');
generateAPI('AuthenticationV1Api');
generateAPI('CertificatesV1Api');
generateAPI('DiscoveryV1beta1Api');
generateAPI('EventsV1beta1Api');
generateAPI('PolicyV1beta1Api');
generateAPI('StorageV1beta1Api');