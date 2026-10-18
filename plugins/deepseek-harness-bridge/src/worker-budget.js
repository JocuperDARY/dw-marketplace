import { installBudget } from './budget.js';
export const name = 'deepseek-bridge-budget';
export const inject = ['llm'];
export const apply = installBudget;
