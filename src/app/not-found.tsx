import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0B0B0C] text-white flex flex-col items-center justify-center p-6 text-center">
      <h2 className="text-4xl font-bold mb-2">404 - Page Not Found</h2>
      <p className="text-[#8a8f98] mb-6">The page you are looking for does not exist.</p>
      <Link href="/" className="px-4 py-2 bg-[#4E8981] hover:bg-[#5fa399] text-white rounded-xl text-sm font-semibold transition-colors">
        Return Home
      </Link>
    </div>
  );
}
