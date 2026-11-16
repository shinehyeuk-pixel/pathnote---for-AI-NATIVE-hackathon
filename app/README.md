# Pathnote

See which files your AI searched, read and wrote, live on a map of your folders.

Pathnote is an MCP server for the folders you choose (notes, an Obsidian vault, project folders) plus a local viewer page. The viewer draws the folders as a tree, with `[[wikilinks]]` between markdown notes. By default the tree holds only what the AI used: each file or folder it searched, read or wrote joins the map as it goes, and "Show all files" draws every file instead. While Claude, Cursor or another MCP client works, it draws the path on top: the files it searched, the folders and files it opened in order, and the files it wrote, linked to the files they came from. Every file the AI creates, edits or moves can be undone from the viewer.

With Claude Code, the viewer shows everything else the AI does too, not only what goes through Pathnote: each request and reply, terminal commands, web searches and pages, other apps' tools, subagents, and failed steps. See [Everything Claude Code does](#everything-claude-code-does).

Free, MIT licensed. Runs entirely on your computer; nothing is sent anywhere by Pathnote.

## Try it

You need Node.js 20 or later. On Windows, open a new PowerShell window after installing it.

One command connects your Documents, Desktop and Downloads folders and adds Pathnote to the AI apps it finds on this computer (Codex, Claude Desktop, Claude Code, Cursor):

```bash
npx -y pathnote setup
```

In Windows PowerShell, use `npx.cmd -y pathnote setup`: PowerShell's default settings stop plain `npx` with "running scripts is disabled on this system".

Then quit those apps completely and open them again (Claude Desktop on Windows: from its icon in the taskbar's notification area), and start a new conversation. Ask something like the line below. The map opens in your browser as soon as the AI starts looking (http://127.0.0.1:4747).

> Go through the meeting notes and customer interviews and write next quarter's priorities as a new note.

To try it on sample notes first, so nothing of yours is touched, connect only those:

```bash
npx -y pathnote --sample ~/pathnote-sample
npx -y pathnote setup ~/pathnote-sample
```

### More folders

- Ask the AI, for example "connect my lecture folder". It can give a full path or just the folder's name. The viewer asks you first, and the folder is connected only if you click **Allow**.
- Or run `npx -y pathnote setup <folder> [<folder> ...]`.
- The list is in `~/.pathnote/folders.json`. Edit it to remove a folder; running Pathnotes pick up the change by themselves.

### Setting it up by hand

`setup` adds a server named `pathnote` that runs `npx -y pathnote` (on Windows `cmd /c npx -y pathnote`). Started without folders, Pathnote uses the list in `~/.pathnote/folders.json`. You can also name the folders instead; then only those are used, and the AI can't add more.

- **Codex**: `codex mcp add pathnote -- npx -y pathnote ~/Documents ~/Projects`
- **Claude Code**: `claude mcp add pathnote -- npx -y pathnote ~/Documents ~/Projects`
- **Claude Desktop**: quit it first, since it rewrites its config file while running. Then add Pathnote to `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

  ```json
  {
    "mcpServers": {
      "pathnote": { "command": "npx", "args": ["-y", "pathnote", "/Users/you/Documents", "/Users/you/Projects"] }
    }
  }
  ```

  On Windows, write folders with forward slashes (`"C:/Users/you/Documents"`) or doubled backslashes, and use `"command": "cmd"` with `"/c", "npx"` at the start of `args`.
- **Cursor and other MCP clients**: the same command, `npx -y pathnote [<folder> ...]`.

## The viewer

- http://127.0.0.1:4747 (the next free port if 4747 is taken; the address is printed to the client's MCP log).
- It opens in your browser by itself the first time the AI uses Pathnote, unless a viewer page is already open. Add `--no-open` (or set `PATHNOTE_NO_OPEN=1`) to turn that off.
- Drag to move, scroll to zoom. File names appear as you zoom in.
- Several AI sessions on the same folders all report to one viewer.
- To keep the viewer open while clients come and go: `npx pathnote <folders> --viewer`.
- Click a step in the activity list to light up its files on the map and zoom to them, with the step that led there. Click it again or press Esc to clear.
- Click a dot to see everything it connects to (its folder, what's inside, links, the files the AI read before writing it) and the steps that touched it, zoomed so they all fit. **Show in Finder** (**Show in folder** on Windows; or a double-click on the dot) opens its folder with the file selected.
- A site's dot has **Open site** (or a double-click) to open it in the browser. Addresses in Claude's replies and in steps are links. A file the AI touched outside the connected folders has **Show in Finder** on its entry; only files that appear in the activity can be shown that way.
- **Undo** puts a file back the way it was before the AI changed it. If you edited it yourself afterwards, Pathnote leaves it alone and says so.
- **Clear path** clears the drawing, not your files.
- With Claude Code, the activity list is one group per request: the request, what came of it (Claude's last reply), and a line with how many steps it took, how many left a mark outside, how many failed and which sites it reached. A group's steps fold under it; **Show steps** opens them. The newest request stays open.
- Click a request to see its **flow**: numbered arrows on the map from the AI through each place, file and site in the order it went.
- **Suggestions** in red, with a red ripple on the map, point at what could have gone better. They are rules, not an AI's judgement:
  - the same step done three times or more;
  - a way that had just failed, tried again as it was;
  - the same file read three times or more in one request;
  - a request the very next one corrected ("잘못", "아니", "wrong", "instead"…), which could have said more up front;
  - a change that was undone later.
  
  A request's summary line counts its suggestions.
- On a Korean page (or `?lang=ko`), English step words are put in Korean by the browser's own translator (Chrome's, which runs on this computer; the first time it may ask to download it). Browsers without one show them as they are.
- Steps are written in plain words: "Open Google login for the channel" rather than the command behind it. **Developer mode** shows the commands and tool calls as the AI made them, along with steps about the conversation itself (task lists, loading tools). The page remembers the choice.

## Everything Claude Code does

Claude Code writes a log of each session as it works (`~/.claude/projects/`, or under `CLAUDE_CONFIG_DIR` when that is set). Pathnote follows those logs, read-only, and draws every step, whether or not the AI used Pathnote's tools:

- **Requests and replies**: what you asked (with the session's name) and what Claude answered, in the activity list. A request starts the path again from **AI** in the middle of the map.
- **Files**: Claude Code's own `Read`, `Write`, `Edit`, `Grep`, `Glob` on files in the connected folders light up the map like Pathnote's tools do. These changes have no Undo button; that only covers changes made through Pathnote.
- **Everything else** goes to a place on a ring around **AI**: **Terminal** (commands, with Claude's description), **Web** (searches and pages), **Browser** (Claude in Chrome and other browser tools), each other app or MCP server by name (outside the edge, like sites), **Scheduled tasks**, **Subagents**, **Claude Code** (its other tools), and **Files outside your folders** (files it touched outside the connected folders, like a picture in a temporary folder).
- **Sites and services** it reaches sit outside the folders, past a dashed line that marks the edge of this computer, in purple, one dot each (`studio.youtube.com`, `googleapis.com`, `github.com`, a Git remote), joined to the place that reached them. Pathnote finds them in the addresses a step uses, in tools known to talk to one (`gh`, `git push`, `wrangler`, `npm publish`, `vercel`, `aws`, `gcloud`…), in the page the browser is on, and in addresses a command prints (a script that calls an API from inside shows once its output names one).
- Steps that **leave a mark outside this computer** (uploading, deploying, publishing, pushing, sending, deleting) are marked in orange, in the activity list and on their sites.
- A step that failed is marked in red with the error.
- Each session draws its own path, so two sessions working at once don't get joined up.

Which sessions: those started in one of the connected folders, and any other session from the moment it touches a file in one. Only what happens after Pathnote starts is shown. Claude's reasoning is not in the logs, so it isn't shown. Add `--no-claude-code` (or set `PATHNOTE_NO_CLAUDE_CODE=1`) to show only Pathnote's own tools.

## Blueprints: hand a piece of work to another agent

**Blueprint** (above the activity list) turns recorded Claude Code work into a plan another agent can follow. Pick the session and the range of requests (from one request to before a later one). Pathnote reads that session's whole log, its subagents' too, and draws it the way the map does:
- the AI in the middle;
- around it, the files and places (terminal, web, browser) the work used;
- past the dashed ring, the sites and other apps it reached;
- the steps as numbered arrows from one to the next. Orange arrows leave a mark outside; red ones failed, with a ring where they failed.

Beside the drawing (under it in a narrow window) are:
- **Goal**: the first request, and the later ones that steered it;
- **Steps**: in plain words, with the numbers on the map, repeats counted;
- **Before**: the files it read and the sign-ins it needed;
- **Results**: the files it wrote;
- **Pitfalls**: steps that failed, what came next, and the user's corrections.

Steps that leave a mark outside this computer are marked "ask the user before doing it".

Edit the text, then save it:
- **as a Claude Code skill**: `~/.claude/skills/<name>/SKILL.md`. Then ask Claude Code to follow that blueprint;
- **as a Codex prompt**: `~/.codex/prompts/<name>.md`, called with `/<name>`;
- **as a file**: `~/.pathnote/blueprints/<name>.md`.

A name that is taken gets `-2`. **Polish with AI** copies the draft with a request to tidy it up, ready to paste into any AI. The AI can also fetch a blueprint itself with the `get_blueprint` tool.

**Skills you already have** open the same way. Under **Which work**, the Claude Code skills in `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) are listed after the recorded work. Pick one and its `SKILL.md` is drawn the same way: each step goes where its words say (a file it names, a site it links, the terminal, the web), and steps that post or upload are orange. A skill Pathnote saved splits back exactly; one you wrote is split by its headings (goal, prerequisites, steps or workflow, output, pitfalls or warnings…) and their lists, and links in it show as sites. Edit the text and the map redraws. **Save over this skill** writes the edit back and keeps the old one in `~/.pathnote/skill-backups`.

## Tools the AI gets

| Tool | What it does |
|---|---|
| `list_files` | The connected folders, or what is inside one folder |
| `search_files` | Text files and documents matching some words, with a snippet each |
| `read_file` | A text file as is (up to 2 MB); PDF, Word, PowerPoint, Excel and Hangul (.hwpx) files as their text; pictures (PNG, JPEG, GIF, WebP, HEIC) as images the AI can see (up to 50 MB) |
| `write_file` | Create a text file or replace its text (undoable). Documents and pictures are never written |
| `edit_file` | Replace one exact piece of text in a file (undoable) |
| `move_file` | Move or rename a file or folder of any type, creating missing folders; never overwrites (undoable) |
| `get_blueprint` | A blueprint of recorded Claude Code work (by default the latest session from its last request), as Markdown with skill front matter |
| `connect_folder` | Ask to use another folder, by full path or by name. The user allows or declines it in the viewer. Only when Pathnote uses the folders file (no folders named on its command line) |

Each tool takes an optional `reason`, a short sentence the viewer shows next to the step.

## What Pathnote touches

- Only files inside the connected folders. Anything outside them is refused, including through symlinks. A folder the AI asks for is connected only after you allow it in the viewer.
- Old Hangul `.hwp` files and other binary formats can't be read. Scanned PDFs without a text layer come back empty.
- Skipped: hidden files and folders, `.git`, `node_modules`, build output, and files that usually hold secrets (`.env`, `*.pem`, `*.p8`, `*.key`, SSH keys, `credentials.json`, `token.json`, `client_secret*.json`, `.git-credentials`, `.pgpass`, `.pypirc`, and folders named `secrets`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker` or `.config`, in any letter case). The AI can't read or write them, also not through a symlink, and the viewer doesn't show them.
- Whatever the AI reads, including document text and pictures, is sent to the AI service you use, like anything else you share with it.
- The AI can create and change any other text file in those folders. Connect only folders you are comfortable letting it edit.
- The text of each file before the AI changed it is kept in `~/.pathnote/` so it can be undone. Delete that folder to clear the history.
- With Claude Code, Pathnote reads its session logs (see above) and shows requests, replies and commands in the viewer. That text stays on your computer; Pathnote doesn't store or send it.
- The viewer only listens on 127.0.0.1 and refuses requests from other websites.

## macOS folder permissions

Desktop, Documents, Downloads and iCloud Drive are protected by macOS. The first time Pathnote reads one, macOS asks whether the app that runs Pathnote (Claude, Terminal, ...) may access it. Until you allow it, the viewer shows that folder as empty and says so. You can change this later in System Settings → Privacy & Security → Files and Folders.

## Development

```bash
npm install
npm test
node bin/pathnote.js examples/sample-vault --viewer
```
