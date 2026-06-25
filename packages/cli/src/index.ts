const HELP = `
pm-compass — personal extensions for obsidian-pm

USAGE
  pm-compass <command> [options]

COMMANDS
  help      Show this help message

OPTIONS
  --help    Show this help message
  --version Show version

More commands will be added as features are implemented.
`.trim();

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args[0] === "help") {
  console.log(HELP);
  process.exit(0);
}

console.error(`Unknown command: ${args[0]}`);
console.error('Run "pm-compass help" for usage.');
process.exit(1);
