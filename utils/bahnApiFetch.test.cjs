const assert = require("node:assert/strict");
const test = require("node:test");
const { brotliCompressSync, deflateSync, gzipSync } = require("node:zlib");
const {
	decompressResponseBody,
	fetchWithBahnFallback,
	parseResponseHeaders,
	requestWithBahnCurl,
} = require("./bahnApiFetch.ts");

test("uses curl directly for Bahn API requests", async () => {
	let fetchCalls = 0;
	let curlCalls = 0;
	const response = await fetchWithBahnFallback(
		"https://www.bahn.de/web/api/angebote/verbindung/example",
		{},
		{
			fetch: () => {
				fetchCalls += 1;
				return Promise.resolve(new Response(null, { status: 403 }));
			},
			curlFetch: () => {
				curlCalls += 1;
				return Promise.resolve(
					new Response('{"ok":true}', { status: 200 })
				);
			},
		}
	);

	assert.equal(response.status, 200);
	assert.equal(fetchCalls, 0);
	assert.equal(curlCalls, 1);
});

test("uses curl directly for the current Bahn journey endpoint", async () => {
	let curlCalls = 0;
	const response = await fetchWithBahnFallback(
		"https://app.services-bahn.de/mob/angebote/fahrplan",
		{},
		{
			fetch: () => Promise.reject(new Error("native fetch must not run")),
			curlFetch: () => {
				curlCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
		}
	);

	assert.equal(response.status, 200);
	assert.equal(curlCalls, 1);
});

test("uses curl for the international Bahn web API", async () => {
	let curlCalls = 0;
	await fetchWithBahnFallback(
		"https://int.bahn.de/web/api/angebote/verbindung/example",
		{},
		{
			fetch: () => Promise.reject(new Error("native fetch must not run")),
			curlFetch: () => {
				curlCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
		}
	);

	assert.equal(curlCalls, 1);
});

test("uses native fetch for requests to other hosts", async () => {
	let fetchCalls = 0;
	let curlCalls = 0;
	const response = await fetchWithBahnFallback(
		"https://example.com/web/api/test",
		{},
		{
			fetch: () => {
				fetchCalls += 1;
				return Promise.resolve(new Response(null, { status: 403 }));
			},
			curlFetch: () => {
				curlCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
		}
	);

	assert.equal(response.status, 403);
	assert.equal(fetchCalls, 1);
	assert.equal(curlCalls, 0);
});

test("does not use curl for non-API Bahn pages", async () => {
	let fetchCalls = 0;
	let curlCalls = 0;
	const response = await fetchWithBahnFallback(
		"https://www.bahn.de/buchung/start",
		{},
		{
			fetch: () => {
				fetchCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
			curlFetch: () => {
				curlCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
		}
	);

	assert.equal(response.status, 200);
	assert.equal(fetchCalls, 1);
	assert.equal(curlCalls, 0);
});

test("does not use curl for insecure Bahn API URLs", async () => {
	let fetchCalls = 0;
	const response = await fetchWithBahnFallback(
		"http://www.bahn.de/web/api/angebote/verbindung/example",
		{},
		{
			fetch: () => {
				fetchCalls += 1;
				return Promise.resolve(new Response(null, { status: 200 }));
			},
			curlFetch: () => Promise.reject(new Error("curl must not run")),
		}
	);

	assert.equal(response.status, 200);
	assert.equal(fetchCalls, 1);
});

test("parses the final header block returned by curl", () => {
	const result = parseResponseHeaders(
		"HTTP/1.1 100 Continue\r\n\r\n" +
			"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
			"Set-Cookie: first=1\r\nSet-Cookie: second=2\r\n\r\n"
	);

	assert.equal(result.status, 200);
	assert.equal(result.statusText, "OK");
	assert.equal(result.headers.get("content-type"), "application/json");
	assert.deepEqual(result.headers.getSetCookie(), ["first=1", "second=2"]);
});

test("rejects curl output without valid response headers", () => {
	assert.throws(
		() => parseResponseHeaders("not an HTTP response"),
		/no HTTP response headers/
	);
});

test("rejects malformed curl status lines", () => {
	assert.throws(
		() => parseResponseHeaders("HTTP/1.1 invalid\r\nContent-Type: text/plain"),
		/invalid HTTP status/
	);
});

test("leaves uncompressed response bodies unchanged", () => {
	const body = Buffer.from("plain response");
	const headers = new Headers({ "content-length": String(body.length) });

	assert.equal(decompressResponseBody(body, headers), body);
	assert.equal(headers.get("content-length"), String(body.length));
});

for (const [encoding, compress] of [
	["gzip", gzipSync],
	["deflate", deflateSync],
	["br", brotliCompressSync],
]) {
	test(`decompresses ${encoding} responses`, () => {
		const headers = new Headers({
			"content-encoding": encoding,
			"content-length": "123",
		});
		const result = decompressResponseBody(
			compress(Buffer.from("bahn response")),
			headers
		);

		assert.equal(result.toString(), "bahn response");
		assert.equal(headers.has("content-encoding"), false);
		assert.equal(headers.has("content-length"), false);
	});
}

const createVendoContext = (transformRequest = (request) => request) => ({
	profile: {
		transformReqBody: (_context, body) => ({ wrapped: body }),
		transformReq: (_context, request) => transformRequest(request),
	},
	opt: { language: "de-DE" },
});

test("adapts db-vendo-client requests and returns the JSON response", async () => {
	let capturedUrl;
	let capturedInit;
	const result = await requestWithBahnCurl(
		createVendoContext(),
		"betterbahn-test",
		{
			endpoint: "https://app.services-bahn.de",
			path: "/mob/angebote/fahrplan",
			method: "post",
			body: { origin: "Bremen" },
			headers: { "X-Test": "yes" },
		},
		{
			fetch: (url, init) => {
				capturedUrl = url;
				capturedInit = init;
				return Promise.resolve(
					new Response('{"journeys":[1]}', {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				);
			},
		}
	);

	assert.equal(
		capturedUrl,
		"https://app.services-bahn.de/mob/angebote/fahrplan"
	);
	assert.equal(capturedInit.method, "post");
	assert.equal(capturedInit.body, '{"wrapped":{"origin":"Bremen"}}');
	assert.equal(capturedInit.headers["Accept-Language"], "de-DE");
	assert.equal(capturedInit.headers["User-Agent"], "betterbahn-test");
	assert.equal(capturedInit.headers["X-Test"], "yes");
	assert.deepEqual(result, { res: { journeys: [1] }, common: {} });
});

test("rejects unsupported Vendo query parameters before fetching", async () => {
	let fetchCalls = 0;
	await assert.rejects(
		requestWithBahnCurl(
			createVendoContext((request) => ({ ...request, query: { page: 1 } })),
			"betterbahn-test",
			{
				endpoint: "https://app.services-bahn.de",
				path: "/mob/location/search",
				method: "post",
				body: {},
			},
			{
				fetch: () => {
					fetchCalls += 1;
					return Promise.resolve(new Response("{}"));
				},
			}
		),
		/query parameters are not supported/
	);
	assert.equal(fetchCalls, 0);
});

test("exposes Bahn HTTP errors to callers", async () => {
	await assert.rejects(
		requestWithBahnCurl(
			createVendoContext(),
			"betterbahn-test",
			{
				endpoint: "https://app.services-bahn.de",
				path: "/mob/angebote/fahrplan",
				method: "post",
				body: {},
			},
			{
				fetch: () =>
					Promise.resolve(
						new Response('{"error":"blocked"}', {
							status: 403,
							statusText: "Forbidden",
						})
					),
			}
		),
		/403 Forbidden/
	);
});

test("exposes Bahn API error messages to callers", async () => {
	await assert.rejects(
		requestWithBahnCurl(
			createVendoContext(),
			"betterbahn-test",
			{
				endpoint: "https://app.services-bahn.de",
				path: "/mob/angebote/fahrplan",
				method: "post",
				body: {},
			},
			{
				fetch: () =>
					Promise.resolve(
						new Response(
							'{"fehlerNachricht":{"text":"Request was blocked"}}'
						)
					),
			}
		),
		/Request was blocked/
	);
});
