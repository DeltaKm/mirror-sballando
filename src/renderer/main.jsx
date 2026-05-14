import React from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import './styles/tailwind.css';
import { KioskScreen } from './kiosk/KioskScreen';
import { AdminScreen } from './admin/AdminScreen';

const router = createHashRouter([
  { path: '/', element: <KioskScreen /> },
  { path: '/admin', element: <AdminScreen /> }
]);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
