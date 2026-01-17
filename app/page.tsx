export default function HomePage() {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Technology Stack Cleanup (MVP)</h1>
        <p>
          Upload your technology inventory (CSV). We parse it in the background and generate a cleaned output file.
        </p>
  
        <a href="/upload">➡️ Go to Upload</a>
      </main>
    );
  }
  