export const metadata = {
  title: "PDF Logo Remover",
  description: "Upload and clean PDFs"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        suppressHydrationWarning
        style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", margin: 24, background: "#f8fafc" }}
      >
        {children}
      </body>
    </html>
  );
}
