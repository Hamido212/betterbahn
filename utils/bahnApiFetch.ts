import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	brotliDecompressSync,
	gunzipSync,
	inflateSync,
} from "node:zlib";

const execFileAsync = promisify(execFile);

const browserUserAgent =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

type FetchImplementation = (
	url: string,
	init?: RequestInit
) => Promise<Response>;

type FetchDependencies = {
	fetch: FetchImplementation;
	curlFetch: FetchImplementation;
};

type VendoRequestContext = {
	profile: {
		transformReqBody: (context: unknown, body: unknown) => unknown;
		transformReq: (
			context: unknown,
			request: RequestInit & { query?: unknown }
		) => RequestInit & { query?: unknown };
	};
	opt: {
		language?: string;
	};
};

type VendoRequestData = {
	endpoint: string;
	path?: string;
	method?: string;
	body?: unknown;
	headers?: HeadersInit;
	query?: unknown;
};

type VendoRequestDependencies = {
	fetch: typeof fetchWithBahnFallback;
};

const isBahnApiUrl = (url: string) => {
	const parsedUrl = new URL(url);

	if (parsedUrl.protocol !== "https:") {
		return false;
	}

	return (
		((parsedUrl.hostname === "www.bahn.de" ||
			parsedUrl.hostname === "int.bahn.de") &&
			parsedUrl.pathname.startsWith("/web/api/")) ||
		(parsedUrl.hostname === "app.services-bahn.de" &&
			parsedUrl.pathname.startsWith("/mob/"))
	);
};

export const parseResponseHeaders = (rawHeaders: string) => {
	const headerBlocks = rawHeaders
		.trim()
		.split(/\r?\n\r?\n/)
		.filter((block) => block.startsWith("HTTP/"));
	const finalHeaderBlock = headerBlocks.at(-1);

	if (!finalHeaderBlock) {
		throw new Error("curl returned no HTTP response headers");
	}

	const [statusLine, ...headerLines] = finalHeaderBlock.split(/\r?\n/);
	const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})\s*(.*)$/);

	if (!statusMatch) {
		throw new Error(`curl returned an invalid HTTP status: ${statusLine}`);
	}

	const headers = new Headers();

	for (const line of headerLines) {
		const separatorIndex = line.indexOf(":");

		if (separatorIndex > 0) {
			headers.append(
				line.slice(0, separatorIndex).trim(),
				line.slice(separatorIndex + 1).trim()
			);
		}
	}

	return {
		status: Number(statusMatch[1]),
		statusText: statusMatch[2],
		headers,
	};
};

export const decompressResponseBody = (body: Buffer, headers: Headers) => {
	const contentEncoding = headers.get("content-encoding")?.toLowerCase();
	let decompressedBody = body;

	if (contentEncoding === "gzip") {
		decompressedBody = gunzipSync(body);
	} else if (contentEncoding === "deflate") {
		decompressedBody = inflateSync(body);
	} else if (contentEncoding === "br") {
		decompressedBody = brotliDecompressSync(body);
	}

	if (decompressedBody !== body) {
		headers.delete("content-encoding");
		headers.delete("content-length");
	}

	return decompressedBody;
};

const fetchWithCurl: FetchImplementation = async (url, init = {}) => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "betterbahn-"));
	const headerFile = join(temporaryDirectory, "headers.txt");
	const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
	const headers = new Headers(init.headers);
	headers.set("User-Agent", browserUserAgent);

	const args = [
		"--silent",
		"--show-error",
		"--http1.1",
		"--connect-timeout",
		"10",
		"--max-time",
		"30",
		"--dump-header",
		headerFile,
		"--request",
		(init.method ?? "GET").toUpperCase(),
	];

	for (const [name, value] of headers.entries()) {
		args.push("--header", `${name}: ${value}`);
	}

	if (typeof init.body === "string") {
		args.push("--data-binary", init.body);
	}

	args.push(url);

	try {
		const { stdout } = await execFileAsync(curlCommand, args, {
			encoding: "buffer",
			maxBuffer: 20 * 1024 * 1024,
			signal: init.signal ?? undefined,
		});
		const rawHeaders = await readFile(headerFile, "utf8");
		const responseInit = parseResponseHeaders(rawHeaders);
		const responseBody = decompressResponseBody(stdout, responseInit.headers);

		return new Response(new Uint8Array(responseBody), responseInit);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				"curl is required to access Deutsche Bahn APIs from this environment",
				{ cause: error }
			);
		}

		throw error;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
};

export const fetchWithBahnFallback = async (
	url: string,
	init: RequestInit,
	dependencies?: FetchDependencies
) => {
	const fetchImplementation = dependencies?.fetch ?? globalThis.fetch;
	const curlFetchImplementation = dependencies?.curlFetch ?? fetchWithCurl;
	const response = await fetchImplementation(url, init);

	if (isBahnApiUrl(url) && [403, 452].includes(response.status)) {
		await response.body?.cancel();
		return await curlFetchImplementation(url, init);
	}

	return response;
};

export const requestWithBahnFallback = async (
	context: VendoRequestContext,
	userAgent: string,
	requestData: VendoRequestData,
	dependencies?: VendoRequestDependencies
) => {
	const { profile, opt } = context;
	const transformedBody = profile.transformReqBody(context, requestData.body);
	const requestOptions = profile.transformReq(context, {
		method: requestData.method,
		body: JSON.stringify(transformedBody),
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"Accept-Language": opt.language ?? "de",
			"User-Agent": userAgent,
			...requestData.headers,
		},
		query: requestData.query,
	});

	if (requestOptions.query) {
		throw new Error("Bahn requests with URL query parameters are not supported");
	}

	const url = requestData.endpoint + (requestData.path ?? "");
	const fetchImplementation = dependencies?.fetch ?? fetchWithBahnFallback;
	const response = await fetchImplementation(url, requestOptions);
	const responseText = await response.text();

	if (!response.ok) {
		const error = new Error(
			`Failed to fetch ${url}: ${response.status} ${response.statusText}`
		);
		Object.assign(error, { response, url });
		throw error;
	}

	const responseBody = JSON.parse(responseText);
	const apiError = responseBody.fehlerNachricht ?? responseBody.errors;

	if (apiError) {
		throw new Error(
			apiError.text ?? apiError.ueberschrift ?? JSON.stringify(apiError)
		);
	}

	return {
		res: responseBody,
		common: {},
	};
};
