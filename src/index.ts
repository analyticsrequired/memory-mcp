#!/usr/bin/env node

import { isMainModule, main, handleCliError } from "@/cli.js";

if (isMainModule(process.argv[1], import.meta.url))
  main().catch(handleCliError);
