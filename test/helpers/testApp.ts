import { Hono } from 'hono'
export function createTestApp(router: Hono) { return new Hono().route('/', router) }
