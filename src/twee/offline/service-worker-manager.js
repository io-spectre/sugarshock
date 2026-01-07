
function initServiceWorkerManager() {
	if (origin === 'null' || !isSecureContext) {
		return;
	}
	if (!('serviceWorker' in navigator)) {
		console.warn("Service workers are not supported in this browser.");
		return;
	}

	let registration = null;
	function onChange(result) {
		if (!result.value) {
			if (registration) {
				registration.unregister().catch(console.error);
				cleanupCachedData();
				registration = null;
			}
			return;
		}

		navigator.serviceWorker.register("./service-worker.js", {
			scope: "./",
			type: "module",
			updateViaCache: "none",
		})
			.then((registration_) => {
				if (!settings.offlineMode) {
					registration_.unregister().catch(console.error);
					cleanupCachedData();
					return;
				}
				registration = registration_;
			})
			.catch(console.error);
	}
	Setting.addToggle("offlineMode", {
		label: "Enable Offline Mode",
		desc: "Allows the application to function without an internet connection by caching necessary resources.",
		default: false,
		onInit: onChange,
		onChange,
	});

	function cleanupCachedData() {
		// keep the constants in sync with service-worker.js
		const scopePath = new URL("./", location.href).pathname;
		const cacheName = `ioV9x-${scopePath}-offline-v1`;
		const dbName = `ioV9x-${scopePath}-offline-index`;
		console.log("Cleaning up cached data for offline mode.", { cacheName, dbName });

		if (caches.has(cacheName)) {
			caches.delete(cacheName).catch(console.error);
		}

		const deleteRequest = indexedDB.deleteDatabase(dbName);
		deleteRequest.addEventListener('error', (event) => {
			console.error('Failed to delete offline asset index database:', event.target.error);
		});
		deleteRequest.addEventListener('blocked', () => {
			console.warn('Deletion of offline asset index database is blocked. Close other tabs using this application.');
		});
	}
}
initServiceWorkerManager();
