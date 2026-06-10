import fs from 'fs';

let content = fs.readFileSync('packages/core/src/proxy/McpProxy.ts', 'utf-8');

// Fix proxy internal imports
content = content.replace(/from "\.\.\/routes\.js"/g, 'from "./routes.js"');
content = content.replace(/from "\.\.\/context\.js"/g, 'from "./context.js"');
content = content.replace(/from "\.\.\/capabilities\.js"/g, 'from "./capabilities.js"');
content = content.replace(/from "\.\.\/middleware\.js"/g, 'from "./middleware.js"');
content = content.replace(/from "\.\.\/operations\.js"/g, 'from "./operations.js"');
content = content.replace(/from "\.\.\/events\.js"/g, 'from "./events.js"');
content = content.replace(/from "\.\.\/lifecycle\.js"/g, 'from "./lifecycle.js"');
content = content.replace(/from "\.\.\/sdkServer\.js"/g, 'from "./sdkServer.js"');

// Fix server imports
content = content.replace(/from "\.\.\/McpServer\.js"/g, 'from "../server/McpServer.js"');
fs.writeFileSync('packages/core/src/proxy/McpProxy.ts', content);

let ctx = fs.readFileSync('packages/core/src/proxy/context.ts', 'utf-8');
ctx = ctx.replace(/from "\.\.\/McpServer\.js"/g, 'from "../server/McpServer.js"');
fs.writeFileSync('packages/core/src/proxy/context.ts', ctx);

let sdk = fs.readFileSync('packages/core/src/proxy/sdkServer.ts', 'utf-8');
sdk = sdk.replace(/from "\.\.\/McpServer\.js"/g, 'from "../server/McpServer.js"');
fs.writeFileSync('packages/core/src/proxy/sdkServer.ts', sdk);

let svr = fs.readFileSync('packages/core/src/server/McpServer.ts', 'utf-8');
svr = svr.replace(/from "\.\/(.*)"/g, 'from "../$1"');
fs.writeFileSync('packages/core/src/server/McpServer.ts', svr);
