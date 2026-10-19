import { installBudget } from './budget.js';
export const name = 'deepseek-bridge-budget';
export const inject = ['llm', 'agents'];
export const apply = installBudget;
