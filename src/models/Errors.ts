export class ApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

export class AuthenticationError extends ApiError {
    constructor(message: string) {
        super(message);
        this.name = 'AuthenticationError';
    }
}

export class HttpError extends ApiError {
    public status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}
