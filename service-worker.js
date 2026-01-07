/// <reference lib="webworker" />
/// <reference types="serviceworker" />

const IDB_STORE_ASSET = 'asset';
const IDB_KEY_OFFLINE_INDEX = 'offline-index.txt';

let refreshCachePromise = null;
const scopePath = new URL(self.registration.scope).pathname;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) =>
	event.waitUntil(synchronizedRefreshCache())
);

self.addEventListener('fetch', (event) => event.respondWith(
	(async () => {
		/** @type {Request} */
		const request = event.request;
		const requestPath = new URL(request.url).pathname;

		if (refreshCachePromise != null) {
			// avoid serving stale content during cache refresh
			return fetch(event.request);
		}
		if (['', 'index.html'].includes(requestPath.slice(scopePath.length))) {
			let offlineAssetIndexDB;
			let cachedIndex;
			try {
				offlineAssetIndexDB = await initOfflineAssetIndex();
				cachedIndex = await idbGet(offlineAssetIndexDB, IDB_STORE_ASSET, IDB_KEY_OFFLINE_INDEX);
			} catch (error) {
				console.error('Failed to retrieve offline index entry:', error);
			}
			if (offlineAssetIndexDB != null) {
				const assetIndex = await fetchAssetIndex(cachedIndex?.lastModified);
				if (assetIndex != null && assetIndex.hash !== cachedIndex?.hash) {
					// defer cache refresh to avoid blocking the fetch
					synchronizedRefreshCache(assetIndex, offlineAssetIndexDB).catch((error) => {
						console.error('Failed to refresh offline cache:', error);
					});
					return fetch(event.request);
				}
				offlineAssetIndexDB.close();
			}
		}

		return (await caches.match(request)) ?? fetch(event.request);
	})()
));

async function synchronizedRefreshCache(cachedAssetIndex, offlineAssetIndexDB) {
	if (refreshCachePromise == null) {
		refreshCachePromise = refreshCache(cachedAssetIndex, offlineAssetIndexDB)
			.finally(() => {
				refreshCachePromise = null;
			});
	}
	return refreshCachePromise;
}

/**
 * @param {{ hash: string, entries: { hash: string, path: string }[] } | null} cachedAssetIndex
 * @param {IDBDatabase | null} offlineAssetIndexDB
 */
async function refreshCache(cachedAssetIndex, offlineAssetIndexDB) {
	const [assetIndex, cache, offlineAssetIndex] = await Promise.all([
		cachedAssetIndex ?? fetchAssetIndex(),
		caches.open(`ioV9x-${scopePath}-offline-v1`),
		offlineAssetIndexDB ?? initOfflineAssetIndex(),
	]);
	if (assetIndex == null) {
		return;
	}

	const previouslyKnownEntries = await new Promise((resolve) => {
		const getDbRequest = offlineAssetIndex.transaction(IDB_STORE_ASSET, 'readwrite')
			.objectStore(IDB_STORE_ASSET)
			.getAllKeys();
		getDbRequest.addEventListener('success', (event) => {
			/**
			 * @type {string[]}
			 */
			resolve(event.target.result);
		});
		getDbRequest.addEventListener('error', (event) => {
			console.error('Failed to retrieve known asset entries:', event.target.error);
			/** @type {IDBObjectStore} */
			const store = event.source;
			const clearRequest = store.clear();
			clearRequest.addEventListener('success', () => {
				resolve([]);
			});
			clearRequest.addEventListener('error', (innerEvent) => {
				console.error('Failed to clear asset store:', innerEvent.target.error);
				reject(innerEvent.target.error);
			});
		});
	});
	await Promise.all(
		previouslyKnownEntries.map(async (path) => {
			if ((await cache.match(new URL(path, self.registration.scope))) == null) {
				try {
					await idbDelete(offlineAssetIndex, IDB_STORE_ASSET, path);
				} catch (error) {
					console.error(`Failed to delete asset index entry for missing cache entry (${path}):`, error);
				}
			}
		})
	);

	await Promise.all(
		assetIndex.entries.map(entry =>
			updateOfflineAsset(entry, cache, offlineAssetIndex)
		)
	);

	const knownPaths = new Set(assetIndex.entries.map(entry => entry.path));
	await Promise.all(
		previouslyKnownEntries
			.filter(path => !knownPaths.has(path))
			.map(async path => {
				try {
					await idbDelete(offlineAssetIndex, IDB_STORE_ASSET, path);
				} catch (error) {
					console.error(`Failed to delete obsolete asset index entry (${path}):`, error);
				}
			})
	);
	const cacheKeys = await cache.keys();
	await Promise.all(
		cacheKeys
			.filter(request => !knownPaths.has('./' + new URL(request.url).pathname.slice(scopePath.length)))
			.map(async request => {
				await cache.delete(request);
			})
	);

	await idbPut(offlineAssetIndex, IDB_STORE_ASSET, {
		path: IDB_KEY_OFFLINE_INDEX,
		hash: assetIndex.hash,
		lastModified: assetIndex.lastModified,
	});

	offlineAssetIndex.close();
}

/**
 *
 * @param {{ hash: string, path: string }} entry
 * @param {Cache} cache
 * @param {IDBDatabase} db
 */
async function updateOfflineAsset(entry, cache, db) {
	const currentEntry = await idbGet(db, IDB_STORE_ASSET, entry.path);
	if (currentEntry?.hash === entry.hash) {
		return;
	}

	await cache.add(entry.path);

	await idbPut(db, IDB_STORE_ASSET, entry);
}

/**
 *
 * @returns {Promise<IDBDatabase>}
 */
async function initOfflineAssetIndex() {
	const openRequest = indexedDB.open(`ioV9x-${scopePath}-offline-index`, 1);
	const { promise, resolve, reject } = Promise.withResolvers();
	openRequest.addEventListener('upgradeneeded', (event) => {
		/** @type {IDBDatabase} */
		const db = event.target.result;
		if (!db.objectStoreNames.contains(IDB_STORE_ASSET)) {
			db.createObjectStore(IDB_STORE_ASSET, { keyPath: 'path' });
		}
	});
	openRequest.addEventListener('success', (event) => {
		/** @type {IDBDatabase} */
		const db = event.target.result;
		resolve(db);
	});
	openRequest.addEventListener('error', (event) => {
		reject(event.target.error);
	});
	return promise;
}

/**
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns	 {Promise<any>}
 */
function idbGet(db, storeName, key) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const getRequest = db.transaction(storeName, 'readonly')
		.objectStore(storeName)
		.get(key);
	getRequest.addEventListener('success', (event) => {
		resolve(event.target.result);
	});
	getRequest.addEventListener('error', (event) => {
		reject(event.target.error);
	});
	return promise;
}
/**
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {*} value
 * @returns {Promise<void>}
 */
function idbPut(db, storeName, value) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const putRequest = db.transaction(storeName, 'readwrite')
		.objectStore(storeName)
		.put(value);
	putRequest.addEventListener('success', () => {
		resolve();
	});
	putRequest.addEventListener('error', (event) => {
		reject(event.target.error);
	});
	return promise;
}

/**
 *
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
function idbDelete(db, storeName, key) {
	const { promise, resolve, reject } = Promise.withResolvers();
	const deleteRequest = db.transaction(storeName, 'readwrite')
		.objectStore(storeName)
		.delete(key);
	deleteRequest.addEventListener('success', () => {
		resolve();
	});
	deleteRequest.addEventListener('error', (event) => {
		reject(event.target.error);
	});
	return promise;
}

/**
 * @returns {Promise<{ hash: string, entries: { hash: string, path: string }[] } | null>}
 */
async function fetchAssetIndex(lastModified) {
	try {
		const response = await fetch('./assets/offline-index.txt', {
			cache: 'no-store',
			headers: {
				'Accept': 'text/plain',
				...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
			}
		});
		if (!response.ok) {
			return null;
		}

		const utf8Text = await response.bytes();
		const indexHash = crypto.subtle.digest('SHA-256', utf8Text);
		const text = new TextDecoder().decode(utf8Text);
		const index = text.split('\n')
			.filter(line => line.length > 0)
			.map(parseAssetIndexEntry);

		const indexHtmlEntry = index.find(e => e.path === './index.html');
		if (indexHtmlEntry) {
			index.unshift({
				hash: indexHtmlEntry.hash,
				path: './',
			});
		}

		return {
			hash: toHex(await indexHash),
			lastModified: response.headers.get('Last-Modified') ?? undefined,
			entries: index,
		};
	}
	catch (error) {
		return null;
	}
}

/**
 * @param {string} line
 */
function parseAssetIndexEntry(line) {
	const delimiterIndex = line.indexOf('  ');
	let hash = line.slice(0, delimiterIndex);
	let path = line.slice(delimiterIndex + 2);
	if (line.charAt(0) === '\\') {
		hash = hash.slice(1);
		path = path.replaceAll('\\n', '\n').replaceAll('\\\\', '\\');
	}
	if (!path.startsWith('./')) {
		path = `./${path}`;
	}
	return { hash, path };
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @returns {string}
 */
function toHex(arrayBuffer)
{
	return Array.prototype.map.call(
		new Uint8Array(arrayBuffer),
		n => n.toString(16).padStart(2, '0')
	).join('');
}
