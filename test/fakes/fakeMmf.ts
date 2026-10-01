// A scriptable MyMiniFactory behind the mocked `requestUrl`. Nothing here touches the network.
import { requestUrl } from 'obsidian';
import { FakeResponseInit, RequestUrlError, makeResponse } from '../mocks/obsidian';
import type { MMFObject } from '../../src/models/MMFObject';

export const API_BASE = 'https://www.myminifactory.com/api/v2';

export interface RecordedRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	throw?: boolean;
}

/**
 * A response to serve, an error for requestUrl to throw (a dropped connection, say), or a
 * promise of a response, for a request the test wants to hold open.
 */
type Outcome = FakeResponseInit | Error | Promise<FakeResponseInit>;

/** A single outcome, or a sequence consumed one per request (the last one repeats). */
type Route = Outcome | Outcome[];

/** What MMF serves when a download is requested without a valid session. */
export const LOGIN_REDIRECT: FakeResponseInit = {
	status: 200,
	headers: { 'content-type': 'text/html; charset=UTF-8' },
	text: '<!DOCTYPE html><html><head><title>Login</title></head><body>Please log in</body></html>',
};

export class FakeMmf {
	requests: RecordedRequest[] = [];
	private routes = new Map<string, Route>();

	/** Points the mocked requestUrl at this fake. */
	install(): this {
		(requestUrl as unknown as jest.Mock).mockImplementation((params: RecordedRequest) => this.handle(params));
		return this;
	}

	/** Serves `object` from GET /objects/{id}. */
	object(object: MMFObject): this {
		return this.objectResponse(String(object.id), { json: object });
	}

	/** Serves an arbitrary response (or sequence of responses) from GET /objects/{id}. */
	objectResponse(id: string, route: Route): this {
		return this.url(`${API_BASE}/objects/${id}`, route);
	}

	/** Serves a response for an exact URL; the query string is ignored when matching. */
	url(url: string, route: Route): this {
		this.routes.set(stripQuery(url), route);
		return this;
	}

	/** Requests made to GET /objects/{id}. */
	objectRequests(id: string): RecordedRequest[] {
		return this.requestsTo(`${API_BASE}/objects/${id}`);
	}

	requestsTo(url: string): RecordedRequest[] {
		return this.requests.filter(request => stripQuery(request.url) === stripQuery(url));
	}

	private async handle(params: RecordedRequest): Promise<ReturnType<typeof makeResponse>> {
		this.requests.push(params);
		const key = stripQuery(params.url);
		const route = this.routes.get(key);
		const count = this.requestsTo(key).length;

		let outcome: Outcome;
		if (route === undefined) {
			outcome = { status: 404, json: { error: 'not_found' } };
		} else if (Array.isArray(route)) {
			outcome = route[Math.min(count, route.length) - 1];
		} else {
			outcome = route;
		}

		if (outcome instanceof Error) throw outcome;
		const init = await outcome;

		const status = init.status ?? 200;
		if (params.throw !== false && status >= 400) {
			throw new RequestUrlError(status, init.headers ?? {});
		}
		return makeResponse(init);
	}
}

function stripQuery(url: string): string {
	const idx = url.indexOf('?');
	return idx === -1 ? url : url.substring(0, idx);
}

/** A response the test releases when it chooses, to hold a request in flight. */
export function heldResponse(init: FakeResponseInit): { response: Promise<FakeResponseInit>; release: () => void } {
	let release!: () => void;
	const response = new Promise<FakeResponseInit>(resolve => {
		release = () => resolve(init);
	});
	return { response, release };
}
