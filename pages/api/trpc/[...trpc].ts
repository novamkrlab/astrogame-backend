import { NextApiRequest, NextApiResponse } from 'next';
import { supabaseAdmin } from '@/lib/supabase';
import { getTokenFromRequest } from '@/lib/auth';

// tRPC batch format response helper
function trpcSuccess(data: unknown) {
  return [{ result: { data: { json: data } } }];
}

function trpcError(message: string, code = 'INTERNAL_SERVER_ERROR') {
  return [{ error: { message, code } }];
}

function setCors(res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Path: /api/trpc/leaderboard.getTop  → trpc = ['leaderboard.getTop']
  const trpcParam = req.query.trpc;
  const procedure = Array.isArray(trpcParam) ? trpcParam.join('/') : trpcParam ?? '';

  // Parse input from query string (GET) or body (POST)
  let input: Record<string, unknown> = {};
  try {
    if (req.method === 'GET' && req.query.input) {
      const parsed = JSON.parse(decodeURIComponent(req.query.input as string));
      input = parsed?.['0']?.json ?? {};
    } else if (req.method === 'POST' && req.body) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      input = body?.['0']?.json ?? {};
    }
  } catch {
    // ignore parse errors, use empty input
  }

  try {
    // ─── leaderboard.getTop ───────────────────────────────────────────────
    if (procedure === 'leaderboard.getTop') {
      const limit = Number(input.limit) || 50;
      const { data, error } = await supabaseAdmin
        .from('leaderboard')
        .select(`score, updated_at, profiles (id, username)`)
        .order('score', { ascending: false })
        .limit(limit);

      if (error) return res.status(500).json(trpcError('Liderlik tablosu alınamadı'));

      const entries = (data || []).map((row: any, i: number) => ({
        rank: i + 1,
        userId: row.profiles?.id ?? null,
        displayName: row.profiles?.username ?? 'Bilinmeyen',
        avatar: '🧑‍🚀',
        totalScore: row.score,
        sciencePoints: row.score,
        level: Math.floor(row.score / 100) + 1,
      }));
      return res.status(200).json(trpcSuccess(entries));
    }

    // ─── leaderboard.getWeeklyTop ─────────────────────────────────────────
    if (procedure === 'leaderboard.getWeeklyTop') {
      const limit = Number(input.limit) || 50;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin
        .from('leaderboard')
        .select(`score, updated_at, profiles (id, username)`)
        .gte('updated_at', weekAgo)
        .order('score', { ascending: false })
        .limit(limit);

      if (error) return res.status(500).json(trpcError('Haftalık liderlik tablosu alınamadı'));

      const entries = (data || []).map((row: any, i: number) => ({
        rank: i + 1,
        userId: row.profiles?.id ?? null,
        displayName: row.profiles?.username ?? 'Bilinmeyen',
        avatar: '🧑‍🚀',
        weeklyPoints: row.score,
        level: Math.floor(row.score / 100) + 1,
        gamesPlayed: 0,
      }));
      return res.status(200).json(trpcSuccess(entries));
    }

    // ─── leaderboard.getMyRank ────────────────────────────────────────────
    if (procedure === 'leaderboard.getMyRank') {
      const user = getTokenFromRequest(req);
      if (!user) return res.status(200).json(trpcSuccess({ rank: null, entry: null }));

      // Count how many users have higher score
      const { data: myData } = await supabaseAdmin
        .from('leaderboard')
        .select('score')
        .eq('user_id', user.userId)
        .single();

      if (!myData) return res.status(200).json(trpcSuccess({ rank: null, entry: null }));

      const { count } = await supabaseAdmin
        .from('leaderboard')
        .select('id', { count: 'exact', head: true })
        .gt('score', myData.score);

      const rank = (count ?? 0) + 1;
      return res.status(200).json(trpcSuccess({ rank, entry: { userId: user.userId } }));
    }

    // ─── leaderboard.getMyWeeklyRank ──────────────────────────────────────
    if (procedure === 'leaderboard.getMyWeeklyRank') {
      const user = getTokenFromRequest(req);
      if (!user) return res.status(200).json(trpcSuccess({ rank: null }));

      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: myData } = await supabaseAdmin
        .from('leaderboard')
        .select('score, updated_at')
        .eq('user_id', user.userId)
        .gte('updated_at', weekAgo)
        .single();

      if (!myData) return res.status(200).json(trpcSuccess({ rank: null }));

      const { count } = await supabaseAdmin
        .from('leaderboard')
        .select('id', { count: 'exact', head: true })
        .gte('updated_at', weekAgo)
        .gt('score', myData.score);

      const rank = (count ?? 0) + 1;
      return res.status(200).json(trpcSuccess({ rank }));
    }

    // ─── friends.addByCode ────────────────────────────────────────────────
    if (procedure === 'friends.addByCode') {
      const user = getTokenFromRequest(req);
      if (!user) return res.status(401).json(trpcError('Giriş yapmanız gerekiyor', 'UNAUTHORIZED'));

      const { friendCode } = input as { friendCode?: string };
      if (!friendCode) return res.status(400).json(trpcError('Arkadaş kodu gerekli', 'BAD_REQUEST'));

      const { data: friend, error: findError } = await supabaseAdmin
        .from('profiles')
        .select('id, username, friend_code')
        .eq('friend_code', friendCode.toString())
        .single();

      if (findError || !friend) return res.status(404).json(trpcError('Bu koda sahip kullanıcı bulunamadı', 'NOT_FOUND'));
      if (friend.id === user.userId) return res.status(400).json(trpcError('Kendinizi ekleyemezsiniz', 'BAD_REQUEST'));

      const { data: existing } = await supabaseAdmin
        .from('friendships')
        .select('id')
        .or(`and(user_id.eq.${user.userId},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.userId})`)
        .single();

      if (existing) return res.status(400).json(trpcError('Bu kullanıcı zaten arkadaşınız', 'BAD_REQUEST'));

      const { error: insertError } = await supabaseAdmin
        .from('friendships')
        .insert({ user_id: user.userId, friend_id: friend.id, status: 'accepted' });

      if (insertError) return res.status(500).json(trpcError('Arkadaş eklenemedi'));

      return res.status(200).json(trpcSuccess({ success: true, friendName: friend.username }));
    }

    // ─── friends.getMyCode ────────────────────────────────────────────────
    if (procedure === 'friends.getMyCode') {
      const user = getTokenFromRequest(req);
      if (!user) return res.status(401).json(trpcError('Giriş yapmanız gerekiyor', 'UNAUTHORIZED'));

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('friend_code')
        .eq('id', user.userId)
        .single();

      return res.status(200).json(trpcSuccess({ friendCode: profile?.friend_code ?? null }));
    }

    // ─── friends.getFriendLeaderboard ─────────────────────────────────────
    if (procedure === 'friends.getFriendLeaderboard') {
      const user = getTokenFromRequest(req);
      if (!user) return res.status(200).json(trpcSuccess([]));

      const { data: friendships } = await supabaseAdmin
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${user.userId},friend_id.eq.${user.userId}`)
        .eq('status', 'accepted');

      const friendIds = (friendships || []).map((f: any) =>
        f.user_id === user.userId ? f.friend_id : f.user_id
      );

      if (friendIds.length === 0) return res.status(200).json(trpcSuccess([]));

      const allIds = [...friendIds, user.userId];
      const { data: scores } = await supabaseAdmin
        .from('leaderboard')
        .select(`score, profiles (id, username)`)
        .in('user_id', allIds)
        .order('score', { ascending: false });

      const entries = (scores || []).map((row: any, i: number) => ({
        rank: i + 1,
        userId: row.profiles?.id ?? null,
        displayName: row.profiles?.username ?? 'Bilinmeyen',
        avatar: '🧑‍🚀',
        totalScore: row.score,
        sciencePoints: row.score,
        level: Math.floor(row.score / 100) + 1,
        isMe: row.profiles?.id === user.userId,
      }));

      return res.status(200).json(trpcSuccess(entries));
    }

    // Unknown procedure
    return res.status(404).json(trpcError(`Unknown procedure: ${procedure}`, 'NOT_FOUND'));
  } catch (err: unknown) {
    console.error('[tRPC handler] Error:', err);
    return res.status(500).json(trpcError('Sunucu hatası'));
  }
}
