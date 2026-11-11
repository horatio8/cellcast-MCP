export const metadata = {
  title: "Cellcast MCP",
  description: "Remote MCP server + webhooks for the Cellcast SMS API.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
