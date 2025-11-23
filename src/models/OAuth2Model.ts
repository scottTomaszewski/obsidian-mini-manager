export interface OAuth2Token {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
    refresh_token: string;
    created_at: number; // a timestamp in seconds
}

export function isTokenExpired(token: OAuth2Token): boolean {
    const now = Math.floor(Date.now() / 1000);
    return now >= token.created_at + token.expires_in;
}
