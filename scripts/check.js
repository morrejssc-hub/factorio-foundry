#!/usr/bin/env node
import { bootFactorioService } from "../src/factorio-process.js";

const summary = await bootFactorioService({ check: true });
console.log(JSON.stringify(summary, null, 2));
