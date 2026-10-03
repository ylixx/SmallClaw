# Quick Start Guide

Get LocalClaw running in 5 minutes!

## Step 1: Prerequisites Check

```bash
# Check Node.js (need 18+)
node --version

# Check Ollama is running
curl http://localhost:11434/api/tags

# If Ollama isn't running:
ollama serve
```

## Step 2: Install LocalClaw

```bash
# From the localclaw directory:
npm install
npm run build
npm link
```

## Step 3: Setup

```bash
# Run the setup wizard
localclaw onboard

# Pull a lightweight model (if you don't have one)
ollama pull qwen3:4b

# Verify everything works
localclaw doctor
```

## Step 4: Run Your First Task

```bash
# Create a simple file
localclaw agent "Create a file called hello.txt with the text 'Hello from LocalClaw!'"

# Check the result
cat ~/localclaw/workspace/hello.txt
```

## Step 5: Try Something More Complex

```bash
# Generate a Python script
localclaw agent "Create a Python script called fibonacci.py that calculates the first 10 Fibonacci numbers and prints them"

# Run it!
python ~/localclaw/workspace/fibonacci.py
```

## Step 6: Monitor Jobs

```bash
# List all jobs
localclaw jobs list

# Show details of the most recent job
localclaw jobs show <job-id-from-list>
```

## Troubleshooting

### "Command not found: localclaw"
```bash
# Make sure you ran npm link
cd /path/to/localclaw
npm link

# Or use npx
npx tsx src/cli/index.ts onboard
```

### "Cannot connect to Ollama"
```bash
# Start Ollama in a separate terminal
ollama serve

# Or check if it's running
ps aux | grep ollama
```

### "Model not found"
```bash
# Pull the default model
ollama pull qwen3:4b

# Or list what you have
ollama list
```

### "Permission denied" or "Path not allowed"
All operations are restricted to `~/localclaw/workspace` by default for safety. Check that your task is creating/reading files in the workspace.

## What's Next?

1. **Read the examples**: Check out `EXAMPLES.md` for more complex use cases
2. **Customize config**: Edit `~/.smallclaw/config.json` to adjust:
   - Which model to use
   - Tool permissions
   - Workspace location
3. **Try different models**: Experiment with qwen2.5-coder:32b or llama-3.3:70b
4. **Build skills**: Create custom SKILL.md files for repeated tasks

## Configuration Tips

### For 8GB RAM
```json
{
  "models": {
    "primary": "qwen3:4b"
  },
  "ollama": {
    "concurrency": {
      "llm_workers": 1,
      "tool_workers": 2
    }
  }
}
```

### For 16GB+ RAM
```json
{
  "models": {
    "primary": "qwen2.5-coder:32b"
  },
  "ollama": {
    "concurrency": {
      "llm_workers": 1,
      "tool_workers": 3
    }
  }
}
```

### For 32GB+ RAM (Recommended)
```json
{
  "models": {
    "roles": {
      "manager": "qwen3:4b",
      "executor": "qwen2.5-coder:32b",
      "verifier": "llama-3.3:70b"
    }
  }
}
```

## Development Mode

If you're developing LocalClaw itself:

```bash
# Watch mode (auto-reload on changes)
npm run dev

# Test a single command without building
npx tsx src/cli/index.ts agent "test mission"
```

## Common First Tasks to Try

1. **File operations**: "Create 3 text files named file1.txt, file2.txt, file3.txt with different content"
2. **Code generation**: "Write a Python class called Calculator with methods for basic arithmetic"
3. **Organization**: "Create folders named src, tests, and docs in the workspace"
4. **Processing**: "Read all .txt files and create a summary.md file listing their names and sizes"

## Success Indicators

You know LocalClaw is working when:
- ✅ `localclaw doctor` shows all green checkmarks
- ✅ You can run `localclaw agent "simple task"` without errors
- ✅ Files appear in `~/localclaw/workspace/` after tasks
- ✅ `localclaw jobs list` shows your completed jobs

## Getting Help

- Check logs: `~/.smallclaw/logs/`
- Review database: `~/.smallclaw/jobs.db` (SQLite)
- Enable verbose logging: Set environment variable `DEBUG=*`

Happy automating! 🦞
