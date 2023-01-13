"use strict";

const ConfigLoader = require("config-mixin");
const Cron = require("cron-mixin");
const { MoleculerClientError } = require("moleculer").Errors;

class Container {
	constructor(id, name, metadata, cluster) {
		this.id = id;
		this.uid = metadata.uid;
		this.name = name;
		this.cluster = cluster;
		this.pod = metadata.name;
		this.namespace = metadata.namespace;
		this.annotations = metadata.annotations;
		this.state = 'created';

		this.running = false;

		this.startedAt = null;
		this.finishedAt = null;
		this.updatedAt = Date.now();

		
		this.reason = null;
		this.message = null;
		this.exitCode = -1

		this.spec = {}

		this.podIP = null;
		this.ports = [];

	}
	toJSON() {
		return {
			id: this.id,
			uid: this.uid,
			name: this.name,
			cluster: this.cluster,
			pod: this.pod,
			namespace: this.namespace,
			annotations: this.annotations,
			state: this.state,
			running: this.running,
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
			updatedAt: this.updatedAt,
			reason: this.reason,
			message: this.message,
			exitCode: this.exitCode,
			podIP: this.podIP,
			ports: this.ports
		}
	}
	generatePorts() {
		if (this.spec.ports)
			for (let index = 0; index < this.spec.ports.length; index++) {
				const element = this.spec.ports[index];
				this.ports.push({
					port: element.containerPort,
					hostname: this.podIP,
					name: element.name,
					type: element.type
				})
			}
	}
	setPodIP(ip) {
		if (!this.podIP && ip) {
			this.podIP = ip;
			this.generatePorts()
		}
	}
	hasPodIP() {
		return this.podIP !== null
	}
	getPodIP() {
		return this.podIP
	}
	setSpec(spec) {
		this.spec = spec
	}
	update(state, info) {

		let changedState = false;

		if (state !== this.state) {
			changedState = true;
			switch (state) {
				case 'running':
					this.running = true;
					break;
				case 'terminated':
					this.exitCode = info.exitCode;
					this.reason = info.reason;
					this.running = false;
					break;
				case 'waiting':
					this.reason = info.reason;
					this.message = info.message;
					this.running = false;
					break;
				default:
					break;
			}
			this.state = state;
		}

		if (info.startedAt && info.startedAt != this.startedAt) {
			this.startedAt = info.startedAt;
		}
		if (info.finishedAt && info.finishedAt != this.finishedAt) {
			this.finishedAt = info.finishedAt;
		}
		if (changedState) {
			this.updatedAt = new Date()
		}
		return changedState;
	}
}

/**
 * attachments of addons service
 */
module.exports = {
	name: "pods",
	version: 1,

	mixins: [
		Cron
	],

	/**
	 * Service dependencies
	 */
	dependencies: [
		'v1.kube'
	],

	/**
	 * Service settings
	 */
	settings: {
		rest: "/v1/pods",

	},
	crons: [
		{
			name: "ClearExpiredPods",
			cronTime: "*/10 * * * *",
			onTick: {
				action: "v1.pods.clearExpired"
			}
		}
	],

	/**
	 * Actions
	 */

	actions: {
		getContainers: {
			rest: "GET /containers",
			description: "Add members to the addon",
			params: {

			},
			async handler(ctx) {
				const { name } = Object.assign({}, ctx.params);

				return Array.from(this.containerMap.values()).map((container) => container.toJSON())
			}
		},
		podLogs: {
			rest: "GET /containers/:id/logs",
			description: "Add members to the addon",
			params: {
				id: { type: "string", optional: false },
			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);

				let container = this.containerMap.get(params.id)

				return container
				return k8sApi.readNamespacedPodLog(params.name, params.ns).then((res) => res.body);
			}
		},
		podEvents: {
			rest: "GET /containers/:name/events",
			description: "Add members to the addon",
			params: {
				name: { type: "string", optional: false },
				ns: { type: "string", default: 'default', optional: true },
			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				return k8sApi.listNamespacedEvent(params.ns, {
					fieldSelector: `involvedObject.name=${params.name}`
				}).then((res) => res.body);
			}
		},
		podEvict: {
			rest: "DELETE /pods/:ns/:name/evict",
			description: "Add members to the addon",
			params: {
				name: { type: "string", optional: false },
				ns: { type: "string", default: 'default', optional: true },
			},
			async handler(ctx) {
				const params = Object.assign({}, ctx.params);
				return k8sApi.createNamespacedPodEviction(params.name, params.ns, {
					"apiVersion": "policy/v1",
					"kind": "Eviction",
					"metadata": {
						"name": params.name,
						"namespace": params.ns
					}
				}).then((res) => res.body);
			}
		},
		clearExpired: {
			//rest: "GET /containers",
			description: "Add members to the addon",
			params: {

			},
			async handler(ctx) {
				const { name } = Object.assign({}, ctx.params);
				const result = []
				for (const [id, container] of this.containerMap.entries()) {

					const containerAge = Date.now() - container.updatedAt

					if (container.state == 'terminated' &&
						containerAge > 60 * 60 * 1000) {
						this.containerMap.delete(id)
						const json = container.toJSON()
						ctx.emit(`pods.containers.prune`, json)
						result.push(json)
						this.logger.info(`Container is ${containerAge / 1000}s old/ Prune now.`)
					} else {
					}

				}
				return result;


			}
		},
	},

	/**
	 * Events
	 */
	events: {
		async "kube.pods.added"(ctx) {
			const event = ctx.params;
			return this.podEvent(ctx, event)
		},
		async "kube.pods.modified"(ctx) {
			const event = ctx.params;
			return this.podEvent(ctx, event)
		},
		async "kube.pods.deleted"(ctx) {
			const event = ctx.params;
			return this.podEvent(ctx, event)
		},
	},

	/**
	 * Methods
	 */
	methods: {
		podEvent(ctx, event, action) {

			const cluster = event.cluster;
			const uid = event.metadata.uid;

			if (event.status.containerStatuses)
				for (let index = 0; index < event.status.containerStatuses.length; index++) {
					const containerStatus = event.status.containerStatuses[index];

					const [state, info = {}] = Object.entries(containerStatus.state).shift() || []
					const [lastState, lastInfo = {}] = Object.entries(containerStatus.lastState).shift() || []

					if (lastState) {
						this.processContainer(ctx, lastInfo.containerID, lastState, lastInfo, containerStatus, event, cluster)
					}
					this.processContainer(ctx, containerStatus.containerID, state, info, containerStatus, event, cluster)
					if (action == 'deleted') {
						this.processContainer(ctx, containerStatus.containerID, 'terminated', info, containerStatus, event, cluster)
					}
				}

		},
		async processContainer(ctx, containerID, state, info, containerStatus, pod, cluster) {

			if (info.startedAt)
				info.startedAt = new Date(info.startedAt)
			if (info.finishedAt)
				info.finishedAt = new Date(info.finishedAt)

			if (containerID == undefined) {

			} else {

				const container = await this.getOrCreateEntity(containerID, containerStatus, pod, cluster)
				const priorState = container.state;
				const updated = await container.update(state, info)
				//console.log(updated, state, container.toJSON())
				if (updated) {
					this.logger.info(`Conatiner  ${container.cluster}${containerID.substring(12, 24)} changed state from ${priorState} to ${container.state}`)
					ctx.emit(`pods.containers.${container.state}`, container.toJSON())
				}
			}

		},
		async getOrCreateEntity(containerID, containerStatus, pod, cluster) {

			const key = `${containerID}`

			let container = this.containerMap.get(key)

			if (!container) {
				this.containerMap.set(key, new Container(containerID, containerStatus.name, pod.metadata, cluster))
				container = this.containerMap.get(key)
				const containerSpec = pod.spec.containers.find((c) => {
					return c.name == containerStatus.name
				})
				container.setSpec(containerSpec)
			}

			if (pod.status.podIP && !container.hasPodIP(pod.status.podIP))
				container.setPodIP(pod.status.podIP)

			return container
		}
	},

	/**
	 * Service created lifecycle event handler
	 */
	created() {
		this.podMap = new Map();
		this.containerMap = new Map();
	},


	/**
	 * Service started lifecycle event handler
	 */
	started() {
		return this.broker.call('v1.kube.find', {
			kind: 'Pod'
		}).then((res) => {
			for (let index = 0; index < res.length; index++) {
				const event = res[index];
				this.podEvent(this.broker, event, event.phase)
			}
		})
	},

	/**
	 * Service stopped lifecycle event handler
	 */
	stopped() { }
};
