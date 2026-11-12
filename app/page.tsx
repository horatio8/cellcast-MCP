export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "64px auto", padding: "0 24px", lineHeight: 1.5 }}>
      <h1>Cellcast MCP</h1>
      <p>Remote MCP server and webhook receiver for the Cellcast SMS API.</p>
      <ul>
        <li><code>POST /api/mcp</code> — MCP endpoint (Streamable HTTP, bearer token)</li>
        <li><code>POST /api/webhook/receive</code> — inbound SMS replies, stored in Airtable</li>
        <li><code>POST /api/webhook/status</code> — delivery reports, stored in Airtable</li>
      </ul>
      <p>See the repository README for setup.</p>
    </main>
  );
}
