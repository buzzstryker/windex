import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Events } from './pages/Events';
import { EventDetail } from './pages/EventDetail';
import { RoundEntry } from './pages/RoundEntry';
import { RoundEdit } from './pages/RoundEdit';
import { AttributionReview } from './pages/AttributionReview';
import { PlayerMapping } from './pages/PlayerMapping';
import { Standings } from './pages/Standings';
import { Groups } from './pages/Groups';
import { GroupDetail } from './pages/GroupDetail';
import { Login } from './pages/Login';
import { PointsAnalysis } from './pages/PointsAnalysis';
import { Players } from './pages/Players';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Layout />}>
        <Route index element={<Login />} />
      </Route>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="events" element={<Events />} />
        <Route path="events/new" element={<RoundEntry />} />
        <Route path="events/:eventId" element={<EventDetail />} />
        <Route path="events/:eventId/edit" element={<RoundEdit />} />
        <Route path="review/attribution" element={<AttributionReview />} />
        <Route path="review/player-mapping" element={<PlayerMapping />} />
        <Route path="standings" element={<Standings />} />
        <Route path="groups" element={<Groups />} />
        <Route path="groups/:groupId" element={<GroupDetail />} />
        <Route path="analytics/points" element={<PointsAnalysis />} />
        <Route path="players" element={<Players />} />
      </Route>
    </Routes>
  );
}
