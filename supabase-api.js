/**
 * Workout Log — Supabase data layer (per-user auth version).
 *
 * The Project URL and publishable key below are meant to be public — that's
 * how every Supabase app ships. They are NOT what protects your data; the
 * database's Row Level Security policies (see supabase/schema.sql) are what
 * actually restrict each signed-in user to their own rows. Don't put a
 * `service_role` / secret key here — that one DOES need to stay private.
 */
var SUPABASE_URL = 'https://hrnkuamsybsrbxiuwpib.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_kJIdV9A-fmM7kRRvhsMkdQ_TluKpyBi';

(function () {
  'use strict';

  var SCHEDULE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  if (!window.supabase || !window.supabase.createClient) {
    window.WorkoutAPI = { loadError: 'supabase-js failed to load (check your internet connection).' };
    return;
  }

  // Links in confirmation / password-reset emails send people back to this page as
  // "#access_token=...&type=signup|recovery" (or "#error=...&error_description=..." if the
  // link expired). Snapshot that BEFORE supabase-js reads it and cleans the address bar.
  var LANDING = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var _session = undefined; // undefined = not checked yet, null = signed out, object = signed in

  sb.auth.onAuthStateChange(function (_event, session) { _session = session; });
  var initialSessionPromise = sb.auth.getSession().then(function (res) {
    _session = res.data.session;
    return _session;
  });

  function client() { return sb; }

  // Unwrap a supabase-js { data, error } result or throw.
  function take(res) {
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data;
  }

  function toArray(v) {
    if (Array.isArray(v)) return v.map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (v === null || v === undefined || v === '') return [];
    return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ---------- shared read helpers ----------

  function mapExercise(r) {
    return {
      id: r.id, name: r.name,
      category: r.category || '', equipment: r.equipment || '',
      muscles: toArray(r.muscles),
      defaultTempo: r.default_tempo || null,
      unilateral: !!r.is_unilateral
    };
  }

  function mapBodyweight(r) {
    return { id: r.id, date: String(r.date), weight: Number(r.weight) };
  }

  function exerciseNameMap() {
    return client().from('exercises').select('id,name,category,equipment').then(take).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) {
        map[r.id] = { name: r.name, category: r.category || '', equipment: r.equipment || '' };
      });
      return map;
    });
  }

  function templateNameMap() {
    return client().from('workout_templates').select('id,name').then(take).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) { map[r.id] = r.name; });
      return map;
    });
  }

  function mapTemplate(row, exMap) {
    var items = Array.isArray(row.exercises) ? row.exercises : [];
    var exercises = items.map(function (it) {
      var ex = exMap[it.exerciseId] || { name: 'Unknown exercise' };
      return { exerciseId: it.exerciseId, name: ex.name, setsReps: it.setsReps || [] };
    });
    return {
      id: row.id,
      name: row.name,
      exercises: exercises,
      exerciseCount: exercises.length,
      totalSets: exercises.reduce(function (n, e) { return n + e.setsReps.length; }, 0),
      durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
      tags: toArray(row.tags)
    };
  }

  function normalizeSchedule(schedule) {
    var map = {};
    (schedule || []).forEach(function (s) { if (s && s.day) map[s.day] = s.workoutId || ''; });
    return SCHEDULE_DAYS.map(function (day) { return { day: day, workoutId: map[day] || '' }; });
  }

  function mapProgram(row, nameMap) {
    var schedule = normalizeSchedule(row.schedule).map(function (s) {
      return {
        day: s.day,
        workoutId: s.workoutId,
        workoutName: s.workoutId ? (nameMap[s.workoutId] || 'Unknown workout') : ''
      };
    });
    return {
      id: row.id,
      name: row.name,
      durationWeeks: row.duration_weeks != null ? Number(row.duration_weeks) : null,
      schedule: schedule,
      workoutCount: schedule.filter(function (s) { return s.workoutId; }).length,
      active: !!row.active
    };
  }

  // ---------- GET actions ----------

  var GET = {
    getExercises: function () {
      return client().from('exercises').select('*').order('name', { ascending: true })
        .then(take).then(function (rows) {
          return (rows || []).map(mapExercise);
        });
    },

    getWorkouts: function () {
      return client().from('workouts_with_counts').select('*')
        .order('date', { ascending: false }).order('created_at', { ascending: false })
        .then(take).then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id,
              date: String(r.date),
              name: r.name || 'Workout',
              notes: r.notes || '',
              exerciseCount: Number(r.exercise_count) || 0,
              setCount: Number(r.set_count) || 0
            };
          });
        });
    },

    getWorkout: function (params) {
      var id = params && params.id;
      if (!id) throw new Error('Workout id is required');
      return Promise.all([
        client().from('workouts').select('*').eq('id', id).single().then(take),
        client().from('sets')
          .select('id,workout_id,block_id,exercise_id,weight,reps,position,to_failure,tempo,side,drop_segments,notes,exercises(name,category,equipment)')
          .eq('workout_id', id).order('position', { ascending: true }).then(take)
      ]).then(function (out) {
        var w = out[0];
        var sets = (out[1] || []).map(function (r) {
          var ex = r.exercises || { name: 'Unknown exercise', category: '', equipment: '' };
          return {
            id: r.id,
            workoutId: r.workout_id,
            blockId: r.block_id,
            exerciseId: r.exercise_id,
            exerciseName: ex.name,
            exerciseCategory: ex.category || '',
            exerciseEquipment: ex.equipment || '',
            weight: r.weight,
            reps: r.reps,
            position: r.position,
            toFailure: !!r.to_failure,
            tempo: r.tempo || null,
            side: r.side || null,
            dropSegments: Array.isArray(r.drop_segments) ? r.drop_segments : [],
            notes: r.notes || null
          };
        });
        return {
          id: w.id, date: String(w.date), name: w.name || 'Workout', notes: w.notes || '', sets: sets
        };
      });
    },

    getExerciseRecords: function (params) {
      var exerciseId = params && params.exerciseId;
      if (!exerciseId) throw new Error('Exercise id is required');
      return client().from('sets').select('weight,reps,drop_segments').eq('exercise_id', exerciseId)
        .then(take).then(function (rows) {
          var byReps = {};
          function consider(reps, weight) {
            reps = Number(reps); weight = Number(weight);
            if (isNaN(reps) || isNaN(weight)) return;
            if (!(reps in byReps) || weight > byReps[reps]) byReps[reps] = weight;
          }
          // A drop set is one logical set, but every completed segment (primary
          // effort + each drop) is a real performance and counts toward the
          // per-rep-count record on its own. `side: 'both'` rows already store
          // the single-side weight (not doubled), so no special-casing needed there.
          (rows || []).forEach(function (r) {
            consider(r.reps, r.weight);
            (Array.isArray(r.drop_segments) ? r.drop_segments : []).forEach(function (seg) {
              if (seg && seg.weight != null) consider(seg.reps, seg.weight);
            });
          });
          return Object.keys(byReps)
            .map(function (k) { return { reps: Number(k), weight: byReps[k] }; })
            .sort(function (a, b) { return a.reps - b.reps; });
        });
    },

    // Newest date first. One entry per day, so the first row is the "current" weight.
    getBodyweightLogs: function () {
      return client().from('bodyweight_logs').select('id,date,weight')
        .order('date', { ascending: false })
        .then(take).then(function (rows) { return (rows || []).map(mapBodyweight); });
    },

    getWorkoutTemplates: function () {
      return Promise.all([
        client().from('workout_templates').select('*').order('created_at', { ascending: true }).then(take),
        exerciseNameMap()
      ]).then(function (out) {
        return (out[0] || []).map(function (row) { return mapTemplate(row, out[1]); });
      });
    },

    getPrograms: function () {
      return Promise.all([
        client().from('programs').select('*').order('created_at', { ascending: true }).then(take),
        templateNameMap()
      ]).then(function (out) {
        return (out[0] || []).map(function (row) { return mapProgram(row, out[1]); });
      });
    }
  };

  // ---------- POST actions ----------

  // Each entry in item.sets is ONE LOGICAL SET, which becomes either one row
  // (the common case, and 'both'-mode unilateral) or two rows sharing one
  // `position` (independent left/right — pass `{ left: {weight,reps}, right: {weight,reps} }`
  // instead of top-level weight/reps). `position` is a single counter shared
  // across the whole workout, so it's globally unique per logical set —
  // that's what lets set_count just count distinct positions. See
  // ADVANCED-LOGGING-DESIGN.md.
  function buildSetRows(workoutId, items) {
    var rows = [];
    var counter = 0;
    (items || []).forEach(function (item) {
      (item.sets || []).forEach(function (s) {
        var position = counter++;
        var toFailure = !!s.toFailure;
        var tempo = s.tempo || null;
        var dropSegments = Array.isArray(s.dropSegments) ? s.dropSegments : [];
        var notes = s.notes || null;
        function row(side, weight, reps) {
          return {
            workout_id: workoutId, block_id: item.blockId || null, exercise_id: item.exerciseId,
            position: position, side: side, weight: weight, reps: reps,
            to_failure: toFailure, tempo: tempo, drop_segments: dropSegments, notes: notes
          };
        }
        if (s.left || s.right) {
          if (s.left)  rows.push(row('left',  s.left.weight,  s.left.reps));
          if (s.right) rows.push(row('right', s.right.weight, s.right.reps));
        } else {
          rows.push(row(s.side || null, s.weight, s.reps));
        }
      });
    });
    return rows;
  }

  // Mirrors workouts_with_counts' set_count: distinct position — a left/right
  // pair shares one position and so counts once, as one logical set.
  function countLogicalSets(rows) {
    var seen = {};
    var n = 0;
    rows.forEach(function (r) {
      if (!seen[r.position]) { seen[r.position] = true; n++; }
    });
    return n;
  }

  var POST = {
    addExercise: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Exercise name is required');
      return client().from('exercises').insert({
        name: name, category: b.category || '', equipment: b.equipment || '', muscles: toArray(b.muscles),
        default_tempo: b.defaultTempo || null, is_unilateral: !!b.unilateral
      }).select().single().then(take).then(mapExercise);
    },

    updateExercise: function (b) {
      if (!b.id) throw new Error('Exercise id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Exercise name is required');
      var patch = {
        name: name, category: b.category || '', equipment: b.equipment || '', muscles: toArray(b.muscles),
        is_unilateral: !!b.unilateral
      };
      // Only touch default_tempo when the caller actually sent it — no UI sets
      // this anymore, but it must not get wiped by callers that don't send it.
      if ('defaultTempo' in b) patch.default_tempo = b.defaultTempo || null;
      return client().from('exercises').update(patch)
        .eq('id', b.id).select().single().then(take).then(mapExercise);
    },

    deleteExercise: function (b) {
      if (!b.id) throw new Error('Exercise id is required');
      return client().from('sets').select('id', { count: 'exact', head: true }).eq('exercise_id', b.id)
        .then(function (res) {
          if (res.error) throw new Error(res.error.message);
          if (res.count > 0) throw new Error('This exercise has logged sets and cannot be deleted.');
          return client().from('exercises').delete().eq('id', b.id).then(take);
        }).then(function () { return { id: b.id, deleted: true }; });
    },

    saveWorkout: function (b) {
      if (!b.date) throw new Error('Workout date is required');
      if (!b.items || !b.items.length) throw new Error('Workout has no exercises to save');
      return client().from('workouts').insert({
        date: b.date, name: (b.name || '').trim() || 'Workout', notes: ''
      }).select().single().then(take).then(function (w) {
        var rows = buildSetRows(w.id, b.items);
        if (!rows.length) throw new Error('Workout has no sets to save');
        return client().from('sets').insert(rows).then(take).then(function () {
          return { id: w.id, date: b.date, setCount: countLogicalSets(rows) };
        });
      });
    },

    updateWorkout: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      if (!b.date) throw new Error('Workout date is required');
      if (!b.items || !b.items.length) throw new Error('Workout has no exercises to save');
      var rows = buildSetRows(b.id, b.items);
      if (!rows.length) throw new Error('Workout has no sets to save');
      return client().from('workouts').update({
        date: b.date, name: (b.name || '').trim() || 'Workout'
      }).eq('id', b.id).then(take)
        .then(function () { return client().from('sets').delete().eq('workout_id', b.id).then(take); })
        .then(function () { return client().from('sets').insert(rows).then(take); })
        .then(function () { return { id: b.id, date: b.date, setCount: countLogicalSets(rows) }; });
    },

    deleteWorkout: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      // sets are removed automatically (ON DELETE CASCADE)
      return client().from('workouts').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    },

    // One entry per day: logging a date that already has one replaces its weight.
    saveBodyweight: function (b) {
      var weight = Number(b.weight);
      if (!b.date) throw new Error('Date is required');
      if (!isFinite(weight) || weight <= 0) throw new Error('Enter a valid weight');
      if (!_session) throw new Error('Not signed in');
      return client().from('bodyweight_logs').upsert(
        { user_id: _session.user.id, date: b.date, weight: weight },
        { onConflict: 'user_id,date' }
      ).select('id,date,weight').single().then(take).then(mapBodyweight);
    },

    updateBodyweight: function (b) {
      var weight = Number(b.weight);
      if (!b.id) throw new Error('Entry id is required');
      if (!b.date) throw new Error('Date is required');
      if (!isFinite(weight) || weight <= 0) throw new Error('Enter a valid weight');
      return client().from('bodyweight_logs').update({ date: b.date, weight: weight })
        .eq('id', b.id).select('id,date,weight').single().then(take).then(mapBodyweight)
        .catch(function (err) {
          if (/duplicate key|unique/i.test(err.message)) throw new Error('You already have a body weight entry for that date.');
          throw err;
        });
    },

    deleteBodyweight: function (b) {
      if (!b.id) throw new Error('Entry id is required');
      return client().from('bodyweight_logs').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    },

    addWorkoutTemplate: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Workout name is required');
      if (!b.exercises || !b.exercises.length) throw new Error('Add at least one exercise');
      var items = b.exercises.map(function (x) { return { exerciseId: x.exerciseId, setsReps: x.setsReps || [] }; });
      return client().from('workout_templates').insert({
        name: name, exercises: items,
        duration_minutes: b.durationMinutes || null, tags: toArray(b.tags)
      }).select().single().then(take).then(function (row) {
        return exerciseNameMap().then(function (m) { return mapTemplate(row, m); });
      });
    },

    updateWorkoutTemplate: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Workout name is required');
      if (!b.exercises || !b.exercises.length) throw new Error('Add at least one exercise');
      var items = b.exercises.map(function (x) { return { exerciseId: x.exerciseId, setsReps: x.setsReps || [] }; });
      return client().from('workout_templates').update({
        name: name, exercises: items,
        duration_minutes: b.durationMinutes || null, tags: toArray(b.tags)
      }).eq('id', b.id).select().single().then(take).then(function (row) {
        return exerciseNameMap().then(function (m) { return mapTemplate(row, m); });
      });
    },

    deleteWorkoutTemplate: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      return client().from('workout_templates').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    },

    addProgram: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Program name is required');
      var chain = b.active
        ? client().from('programs').update({ active: false }).eq('active', true).then(take)
        : Promise.resolve();
      return chain.then(function () {
        return client().from('programs').insert({
          name: name, duration_weeks: b.durationWeeks || null,
          schedule: normalizeSchedule(b.schedule), active: !!b.active
        }).select().single().then(take);
      }).then(function (row) {
        return templateNameMap().then(function (m) { return mapProgram(row, m); });
      });
    },

    updateProgram: function (b) {
      if (!b.id) throw new Error('Program id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Program name is required');
      var chain = b.active
        ? client().from('programs').update({ active: false }).eq('active', true).neq('id', b.id).then(take)
        : Promise.resolve();
      return chain.then(function () {
        return client().from('programs').update({
          name: name, duration_weeks: b.durationWeeks || null,
          schedule: normalizeSchedule(b.schedule), active: !!b.active
        }).eq('id', b.id).select().single().then(take);
      }).then(function (row) {
        return templateNameMap().then(function (m) { return mapProgram(row, m); });
      });
    },

    deleteProgram: function (b) {
      if (!b.id) throw new Error('Program id is required');
      return client().from('programs').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    }
  };

  // ---------- auth ----------

  // Turns Supabase's auth errors into messages a person can act on. `.code` lets the UI react
  // ('unconfirmed' -> offer to resend the email, 'exists' -> offer to sign in instead).
  function authError(err) {
    var msg = (err && err.message) || 'Something went wrong. Please try again.';
    var e = new Error(msg);
    if (/invalid login credentials/i.test(msg)) e.message = 'Incorrect email or password.';
    else if (/email not confirmed/i.test(msg)) { e.message = 'Please confirm your email first. Check your inbox for the link.'; e.code = 'unconfirmed'; }
    else if (/already (been )?registered/i.test(msg)) { e.message = 'An account with this email already exists. Try signing in instead.'; e.code = 'exists'; }
    else if (/rate limit|too many|only request this after|security purposes/i.test(msg)) e.message = 'Too many attempts. Please wait a minute and try again.';
    else if (/error sending .*email|sending .*email/i.test(msg)) e.message = "We couldn't send the email right now. Please try again in a bit.";
    else if (/invalid email|unable to validate email|valid email/i.test(msg)) e.message = 'Enter a valid email address.';
    return e;
  }

  // Emailed links (confirm / reset) land back on this same page.
  function appUrl() { return window.location.origin + window.location.pathname; }

  function signIn(email, password) {
    return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error) throw authError(res.error);
      _session = res.data.session;
      return _session;
    });
  }

  // Resolves { needsConfirmation }. With email confirmation ON there's no session yet — the
  // person has to click the emailed link first. (If confirmation is off in Supabase, they're
  // signed in immediately and needsConfirmation is false.)
  function signUp(email, password) {
    return sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: appUrl() } }).then(function (res) {
      if (res.error) throw authError(res.error);
      var user = res.data.user;
      // Supabase hides "this email is already registered" when confirmation is on: instead of
      // an error it returns a user with no identities. Surface that as a real message.
      if (user && Array.isArray(user.identities) && user.identities.length === 0) {
        var e = new Error('An account with this email already exists. Try signing in instead.');
        e.code = 'exists';
        throw e;
      }
      if (res.data.session) _session = res.data.session;
      return { needsConfirmation: !res.data.session };
    });
  }

  function resendConfirmation(email) {
    return sb.auth.resend({ type: 'signup', email: email, options: { emailRedirectTo: appUrl() } })
      .then(function (res) { if (res.error) throw authError(res.error); });
  }

  // Always resolves for a well-formed address whether or not an account exists (by design —
  // it doesn't reveal who's registered).
  function resetPassword(email) {
    return sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() })
      .then(function (res) { if (res.error) throw authError(res.error); });
  }

  function updatePassword(newPassword) {
    return sb.auth.updateUser({ password: newPassword })
      .then(function (res) { if (res.error) throw authError(res.error); });
  }

  // What the page was opened from: { type: 'signup' | 'recovery' | '', error: '' }.
  function getLanding() {
    var error = LANDING.get('error_description') || (LANDING.get('error') ? 'That link is invalid or has expired.' : '');
    return { type: LANDING.get('type') || '', error: error.replace(/\+/g, ' ') };
  }
  function signOut() {
    return sb.auth.signOut().then(function () { _session = null; });
  }
  function getSession() {
    // resolves once the initial check has run, then reflects live state
    return initialSessionPromise.then(function () { return _session; });
  }
  function getCachedSession() { return _session || null; }

  // ---------- public surface ----------

  window.WorkoutAPI = {
    signIn: signIn,
    signUp: signUp,
    resendConfirmation: resendConfirmation,
    resetPassword: resetPassword,
    updatePassword: updatePassword,
    getLanding: getLanding,
    signOut: signOut,
    getSession: getSession,
    getCachedSession: getCachedSession,
    apiGet: function (action, params) {
      return Promise.resolve().then(function () {
        if (!GET[action]) throw new Error('Unknown action: ' + action);
        return GET[action](params || {});
      });
    },
    apiPost: function (action, payload) {
      return Promise.resolve().then(function () {
        if (!POST[action]) throw new Error('Unknown action: ' + action);
        return POST[action](payload || {});
      });
    }
  };
})();
