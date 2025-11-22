export interface MMFObjectImage {
    id: string | number;
    upload_id?: string;
    is_primary?: boolean;
    original?: {
        url: string;
        width?: number | null;
        height?: number | null;
    };
    tiny?: {
        url: string;
        width?: number;
        height?: number;
    };
    thumbnail?: {
        url: string;
        width?: number;
        height?: number;
    };
    standard?: {
        url: string;
        width?: number;
        height?: number;
    };
    large?: {
        url: string;
        width?: number;
        height?: number;
    };
    is_print_image_selected?: boolean;
    url?: string; // For backward compatibility
    position?: number;
}

export interface MMFObjectDesigner {
    id: string | number;
    name: string;
    url: string;
}

export interface MMFObjectFile {
    id: string | number;
    filename: string;
    size: number;
    download_url?: string; // Direct download link
}

export interface MMFObjectFilesContainer {
    total_count: number;
    items: MMFObjectFile[];
}

export interface MMFObject {
    id: string | number;
    name: string;
    url: string;
    description: string;
    description_html?: string;
    status?: number | string;
    status_name?: string;
    visibility?: number | string;
    visibility_name?: string;
    listed?: boolean;
    publishedAt?: string;
    createdAt?: string;
    updatedAt?: string;
    tags?: string[];
    categories?: string[];
    images: MMFObjectImage[];
    designer?: MMFObjectDesigner;
    files?: MMFObjectFilesContainer;
    license?: string;
    likesCount?: number;
    downloadsCount?: number;
    viewsCount?: number;
    printing_details?: string;
    printing_details_html?: string;
    featured?: boolean;
    support?: boolean;
    complexity?: number | null;
    complexity_name?: string | null;
    dimensions?: string;
    material_quantity?: string | null;
}

export interface MMFSearchResponse {
    objects: MMFObject[];
    total: number;
    page: number;
    perPage: number;
}
