'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { readToken } from '@/lib/api';

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(readToken() ? '/licenses/' : '/login/');
  }, [router]);
  return null;
}
