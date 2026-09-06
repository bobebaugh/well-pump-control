# Well Pump Control

This repository contains two coordinated applications:

- **Pilot** — browser HMI, Netlify functions, Firebase/Firestore services, and immutable runtime-package publication.
- **Tab5** — local interpreted MicroPython device application.

## Start here

The current entry point is the **Project Context**:

1. AGENTS.md
2. CURRENT.md
3. DESIGN.md
4. interfaces/ when the task crosses the Pilot–Tab5 boundary

Those records define current status and instructions. This README is only a landing page; it is not a second design or workflow authority.

## Product lines

- pilot is the Pilot operating branch; pilot-working is its reusable development branch.
- Tab5 is the Tab5 operating branch; tab5-working is its reusable development branch.
- Promotion into either operating branch requires explicit owner approval.

## Historical material

The ESP-IDF firmware/ tree, old development workflow, old runbook, and Google Drive design records are not current starting instructions. They may be used only when a current task specifically requires named historical evidence.
