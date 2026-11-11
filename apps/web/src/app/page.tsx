import { headers } from 'next/headers';
import WorkspacePage from './workspace';

export default async function Page() {
  const nonce = (await headers()).get('x-paymandate-nonce') ?? '';
  return <WorkspacePage nonce={nonce}/>;
}