// serve.js is a simple HTTP server that serves the test.html file and the dist folder
// It is used to test the ServiceWorkerWallet implementation in test.html
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
};

const server = http.createServer((req, res) => {
    // Set security headers
    res.setHeader(
        "Content-Security-Policy",
        `
        default-src 'self';
        script-src 'self' 'unsafe-eval' 'unsafe-inline';
        worker-src 'self' 'unsafe-eval' blob:;
        connect-src 'self' http://localhost:7070 http://localhost:3000;
        style-src 'self' 'unsafe-inline';
    `
            .replace(/\s+/g, " ")
            .trim()
    );

    // Handle CORS for service worker
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve test.html for root
    if (req.url === "/") {
        fs.readFile(path.join(__dirname, "./test.html"), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end("Error loading test.html");
            } else {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(data);
            }
        });
        return;
    }

    // Handle file requests
    let filePath;
    if (req.url.startsWith("/dist/")) {
        // Direct request to dist folder
        filePath = path.join(__dirname, "../..", req.url);
    } else {
        // Try dist/browser for other module requests
        filePath = path.join(__dirname, "../../dist/browser", req.url);
    }

    // Add .js extension if no extension exists
    if (!path.extname(filePath)) {
        filePath += ".js";
    }

    // Get the file extension and MIME type
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`Error reading file ${filePath}:`, err);
            res.writeHead(404);
            res.end(`File not found: ${req.url}`);
            return;
        }

        // Special handling for JavaScript files
        if (ext === ".js") {
            // Add source map header if a map file exists
            const mapPath = filePath + ".map";
            if (fs.existsSync(mapPath)) {
                res.setHeader("SourceMap", path.basename(filePath) + ".map");
                res.setHeader("X-SourceMap", path.basename(filePath) + ".map");
            }
        }

        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
});

const PORT = 3030;
server.listen(PORT, () => {
    console.log(`Test server running at http://localhost:${PORT}`);
    console.log("Press Ctrl+C to stop the server");
});
