import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration & Constants ---
const PORT = process.env.PORT || 3000;
const ASGARDEO_TENANT_ID = process.env.ASGARDEO_TENANT_ID; // Now from .env
const ASGARDEO_ME_ENDPOINT = `https://api.asgardeo.io/t/${ASGARDEO_TENANT_ID}/scim2/Me`;

const ERROR_MISSING_TOKEN = "missing_token";
const ERROR_INVALID_TOKEN = "invalid_token";

const SCOPE_INTERNAL_LOGIN = "internal_login";
const SCOPE_MOBILE = "mobile";

// --- MCP Server Setup ---
const server = new McpServer({
    name: "backwards-compatible-server",
    version: "1.0.0"
});

// --- Helper Functions ---

/**
 * Fetches user data from Asgardeo.
 * @param {string} accessToken - The Asgardeo access token.
 * @returns {Promise<object>} The user data object.
 * @throws {Error} If the token is invalid (custom error with `isAuthError` flag) or another API error occurs.
 */
async function fetchAsgardeoUser(accessToken) {
    try {
        const response = await axios.get(ASGARDEO_ME_ENDPOINT, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 401) {
            const authError = new Error("Asgardeo authentication failed: Token is invalid or expired.");
            authError.isAuthError = true; // Custom flag to identify auth errors
            authError.statusCode = 401;
            throw authError;
        }
        const errorMsg = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Failed to fetch user info from Asgardeo: ${errorMsg}`);
    }
}

/**
 * Creates a generic MCP tool structure for Asgardeo user data.
 * @param {string} toolName - The name of the tool.
 * @param {string[]} requiredScopes - Scopes required for this tool.
 * @param {function(object): string} dataExtractor - Function to extract specific data from the user object.
 * @param {string} missingTokenMessage - Message for missing token error.
 * @param {string} invalidTokenMessage - Message for invalid token error.
 * @param {string} successMessagePrefix - (Optional) Prefix for successful data retrieval.
 * @param {string} failureMessagePrefix - Prefix for failure messages.
 */
function createAsgardeoUserTool(
    toolName,
    requiredScopes,
    dataExtractor,
    missingTokenMessage,
    invalidTokenMessage,
    failureMessagePrefix
) {
    server.tool(
        toolName,
        { access_token: z.string().optional() },
        async ({ access_token }) => {
            if (!access_token) {
                return {
                    error: ERROR_MISSING_TOKEN,
                    required_scopes: requiredScopes,
                    message: missingTokenMessage
                };
            }

            try {
                const user = await fetchAsgardeoUser(access_token);
                const extractedData = dataExtractor(user);
                return {
                    content: [{ type: "text", text: extractedData }]
                };
            } catch (e) {
                if (e.isAuthError) {
                    return {
                        error: ERROR_INVALID_TOKEN,
                        required_scopes: requiredScopes,
                        message: invalidTokenMessage
                    };
                }
                // For other errors from fetchAsgardeoUser or dataExtractor
                return {
                    content: [{ type: "text", text: `${failureMessagePrefix}: ${e.message.replace('Failed to fetch user info from Asgardeo: ', '')}` }]
                };
            }
        }
    );
}

// --- Tool Definitions ---

server.tool(
    "print-whatever",
    { msg: z.string() },
    async ({ msg }) => ({
        content: [{ type: "text", text: msg }]
    })
);

createAsgardeoUserTool(
    "getUserName",
    [SCOPE_INTERNAL_LOGIN],
    (user) => user.displayName || user.userName || "Unknown",
    "Access token required for getUserName.",
    "Access token invalid or expired for getUserName.",
    "Failed to fetch username"
);

createAsgardeoUserTool(
    "getFirstName",
    [SCOPE_INTERNAL_LOGIN],
    (user) => user.name?.givenName || "Unknown",
    "Access token required for getFirstName.",
    "Access token invalid or expired for getFirstName.",
    "Failed to fetch first name"
);

createAsgardeoUserTool(
    "getUserMobile",
    [SCOPE_INTERNAL_LOGIN, SCOPE_MOBILE],
    (user) => {
        if (Array.isArray(user.phoneNumbers)) {
            const mobileObj = user.phoneNumbers.find(p => p.type === "mobile");
            return mobileObj?.value || "Mobile not found";
        }
        return "Mobile not found";
    },
    "Access token required for getUserMobile.",
    "Access token invalid or expired for getUserMobile.",
    "Failed to fetch mobile number"
);


// --- Express App Setup ---
const app = express();
app.use(express.json());

// Store transports for each session type - simplified for this example
const sseTransports = new Map(); // Using a Map for better session management

app.get('/sse', async (req, res) => {
    console.log("SSE connection requested");
    const transport = new SSEServerTransport('/messages', res); // Path here is relative to where client posts
    sseTransports.set(transport.sessionId, transport);

    res.on("close", () => {
        console.log(`SSE connection closed for session: ${transport.sessionId}`);
        sseTransports.delete(transport.sessionId);
        // Optionally, inform the McpServer about the disconnect if it has such a method
        // server.disconnect(transport.sessionId); // Or similar, if SDK supports it
    });

    try {
        await server.connect(transport);
        console.log(`SSE transport connected for session: ${transport.sessionId}`);
    } catch (error) {
        console.error(`Error connecting SSE transport for session ${transport.sessionId}:`, error);
        // Ensure response is properly ended if connect fails and doesn't throw in a way that kills the stream
        if (!res.headersSent) {
            res.status(500).send("Failed to establish SSE connection with MCP server.");
        }
        sseTransports.delete(transport.sessionId);
    }
});

app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== 'string') {
        return res.status(400).send('Missing or invalid sessionId query parameter.');
    }

    const transport = sseTransports.get(sessionId);

    if (transport) {
        try {
            await transport.handlePostMessage(req, res, req.body);
        } catch (error) {
            console.error(`Error handling POST message for session ${sessionId}:`, error);
            if (!res.headersSent) {
                res.status(500).send('Error processing message.');
            }
        }
    } else {
        console.warn(`No transport found for sessionId: ${sessionId}`);
        res.status(404).send('No active SSE transport found for the provided sessionId. Please establish an SSE connection first via GET /sse.');
    }
});

app.listen(PORT, () => {
    console.log(`MCP server with SSE transport listening on http://localhost:${PORT}`);
});