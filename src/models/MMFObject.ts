export interface MMFObjectImage {
    id: string;
    url: string;
    position?: number;
}

export interface MMFObjectDesigner {
    id: string;
    name: string;
    url: string;
}

export interface MMFObjectFile {
    id: string;
    filename: string;
    filesize: number;
    url?: string;
}

export interface MMFObject {
    id: string;
    name: string;
    url: string;
    description: string;
    status: string;
    visibility: string;
    publishedAt: string;
    createdAt: string;
    updatedAt: string;
    tags: string[];
    categories: string[];
    images: MMFObjectImage[];
    designer: MMFObjectDesigner;
    files: MMFObjectFile[];
    license?: string;
    likesCount: number;
    downloadsCount: number;
    viewsCount: number;
}

export interface MMFSearchResponse {
    objects: MMFObject[];
    total: number;
    page: number;
    perPage: number;
}
