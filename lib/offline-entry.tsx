import {createRoot} from 'react-dom/client';
import DistributionApp from '../app/distribution-app';
import {PwaInstall} from '../components/pwa';
createRoot(document.getElementById('offline-app')!).render(<><DistributionApp/><PwaInstall/></>);
