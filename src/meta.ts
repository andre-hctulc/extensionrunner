/**
 *  Module Meta
 * */
export interface Meta {
    authToken: string;
    name: string;
    path: string;
    version: string;
    type: "github" | "npm";
    windowType: "iframe" | "worker";
    initialState: any;
    data?: any;
}
