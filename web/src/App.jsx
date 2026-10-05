import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LangProvider } from './lib/i18n.jsx';
import { AppProvider, AuthProvider, useApp } from './lib/store.jsx';
import { ToastProvider, DialogProvider, Loading } from './components/ui.jsx';

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));
const CustomerDisplay = lazy(() => import('./display/CustomerDisplay.jsx'));
const BookingApp = lazy(() => import('./booking/BookingApp.jsx'));
const RoomOrderApp = lazy(() => import('./order/RoomOrderApp.jsx'));

function LangBoot({ children }) {
  return children;
}

function WithLang({ children }) {
  return <LangProvider defaultLang="th">{children}</LangProvider>;
}

function DefaultLangSync() {
  // apply admin default language for first-time visitors
  const { publicSettings } = useApp();
  if (publicSettings?.appearance?.defaultLanguage && !localStorage.getItem('bb_lang')) {
    localStorage.setItem('bb_lang', JSON.stringify(publicSettings.appearance.defaultLanguage));
    if (publicSettings.appearance.defaultLanguage !== 'th') window.location.reload();
  }
  return null;
}

export default function App() {
  return (
    <WithLang>
      <AppProvider>
        <DefaultLangSync />
        <ToastProvider>
          <DialogProvider>
            <BrowserRouter>
              <Suspense fallback={<Loading />}>
                <LangBoot>
                  <Routes>
                    <Route path="/display/*" element={<CustomerDisplay />} />
                    <Route path="/book/*" element={<BookingApp />} />
                    <Route path="/order/:token" element={<RoomOrderApp />} />
                    <Route
                      path="/*"
                      element={
                        <AuthProvider>
                          <AdminApp />
                        </AuthProvider>
                      }
                    />
                    <Route path="*" element={<Navigate to="/" />} />
                  </Routes>
                </LangBoot>
              </Suspense>
            </BrowserRouter>
          </DialogProvider>
        </ToastProvider>
      </AppProvider>
    </WithLang>
  );
}
