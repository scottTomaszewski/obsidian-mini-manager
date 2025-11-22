/**
 * @deprecated This model is kept for backward compatibility only.
 * The plugin now uses API key authentication instead of OAuth2.
 */
export interface OAuth2Token {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
    created_at: number; // Timestamp when the token was created
}

/**
 * @deprecated This function is kept for backward compatibility only.
 */
export function isTokenExpired(token: OAuth2Token | null): boolean {
    if (!token) return true;
    
    const currentTime = Math.floor(Date.now() / 1000);
    const tokenExpiry = token.created_at + token.expires_in - 60; // 60 seconds buffer
    
    return currentTime >= tokenExpiry;
}
