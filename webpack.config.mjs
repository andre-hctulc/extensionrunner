import path from "path";
import HtmlBundlerPlugin from "html-bundler-webpack-plugin";

/*
See script test:build
*/

const config = {
    output: {
        path: path.resolve("./test/dist/"),
    },
    plugins: [
        new HtmlBundlerPlugin({
            entry: "./test/",
            js: { inline: true },
        }),
    ],
    module: {
        rules: [],
    },
};

export default config;
