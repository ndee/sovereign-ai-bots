// Stub entry — replaced in Phase 3 with full mail-sentinel CLI.
async function main(): Promise<void> {
  process.stdout.write("mail-sentinel stub\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
