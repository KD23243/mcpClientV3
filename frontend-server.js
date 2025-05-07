import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import crypto from "crypto";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
dotenv.config();

// Constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.FRONTEND_PORT || 5178;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const CLIENT_ID = process.env.CLIENT_ID;
const SCOPE = process.env.SCOPE;
const OPENID_CONFIG_URL = process.env.OPENID_CONFIG_URL;
const SSE_URL = process.env.SSE_URL;

// App Setup
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

// App State
let lastResults = null;
let codeVerifier = null;
let state = null;

// Utility Functions
const generatePKCE = () => {
    codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    return { codeVerifier, codeChallenge };
};

const fetchOpenIDConfig = async () => {
    const res = await fetch(OPENID_CONFIG_URL);
    if (!res.ok) throw new Error("Failed to fetch OpenID config");
    return res.json();
};

// Routes
app.get("/login", async (req, res) => {
    try {
        const config = await fetchOpenIDConfig();
        const { codeChallenge } = generatePKCE();
        state = crypto.randomBytes(16).toString("hex");

        const authUrl = `${config.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;

        res.redirect(authUrl);
    } catch (err) {
        res.status(500).send("Login error: " + err.message);
    }
});

app.get("/callback", async (req, res) => {
    if (req.query.state !== state) return res.status(400).send("Invalid state");

    try {
        const config = await fetchOpenIDConfig();
        const params = new URLSearchParams({
            grant_type: "authorization_code",
            code: req.query.code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier
        });

        const tokenRes = await fetch(config.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params
        });

        if (!tokenRes.ok) {
            const errorText = await tokenRes.text();
            throw new Error("Token error: " + errorText);
        }

        const tokenData = await tokenRes.json();
        res.cookie("access_token", tokenData.access_token, { httpOnly: true });

        res.send(`
            <html><body>
            <script>
                if (window.opener) {
                    window.opener.postMessage('asgardeo-login-success', '*');
                    window.close();
                } else {
                    window.location = '/chat.html';
                }
            </script>
            <p>Login successful. You can close this tab.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get("/results", (req, res) => {
    res.json(lastResults || { error: "No results yet. Please login." });
});

app.get("/chat", async (req, res) => {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.json({ result: "Please login first using /login." });

    const toolName = req.query.tool;
    const toolMap = {
        mobile: "getUserMobile",
        username: "getUserName",
        firstname: "getFirstName"
    };

    const tool = toolMap[toolName];
    if (!tool) return res.json({ result: "Unknown tool. Try 'mobile', 'username', or 'firstname'." });

    try {
        const client = new Client({ name: "sse-client", version: "1.0.0" });
        const sseTransport = new SSEClientTransport(new URL(SSE_URL));
        await client.connect(sseTransport);

        const result = await client.callTool({ name: tool, arguments: { access_token: accessToken } });

        if (result?.content?.length) {
            const text = result.content
                .filter(item => item.type === "text" && typeof item.text === "string")
                .map(item => item.text)
                .join("\n");
            return res.json({ result: text });
        }

        res.json({ result });
    } catch (err) {
        res.status(500).json({ result: "Tool call failed: " + err.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Frontend server running at http://localhost:${PORT}/home.html`);
});
